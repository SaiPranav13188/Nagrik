import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { notifyUser } from '../services/notify.js';
import { runAgent, type AgentDefinition } from '../ai/runtime.js';
import { jurisdictionAgent } from './jurisdiction.js';
import { draftingAgent } from './drafting.js';
import { submissionAgent } from './submission.js';

/**
 * The Coordinator decides how a freshly-analyzed complaint moves through the pipeline, calling the
 * specialist agents as tools. Hard guardrails live inside the tools, not in this prompt.
 */

export interface CoordinatorInput {
  complaintId: string;
}

/** Injected by the scheduler to avoid a circular import. */
export const submissionHooks = {
  schedule: (_complaintId: string, _atMs: number) => {},
};

export async function runSubmission(complaintId: string, citizenConfirmed = false) {
  const c = await repo.getComplaint(complaintId);
  if (!c || !['drafted', 'submission_failed'].includes(c.status)) return;
  await repo.updateComplaint(complaintId, { status: 'submitting', submit_after: null });
  try {
    const r = await runAgent(submissionAgent, { complaintId, citizenConfirmed }, { complaintId, userId: c.user_id });
    const after = await repo.getComplaint(complaintId);
    if (after?.status === 'submitting') {
      // The agent ended without a terminal decision — never leave a complaint stuck.
      await repo.updateComplaint(complaintId, { status: 'submission_failed', failure_reason: `[portal_error] Automatic filing did not complete. ${r.text}`.trim() });
    }
  } catch (e) {
    await repo.updateComplaint(complaintId, {
      status: 'submission_failed',
      failure_reason: `[portal_error] Something went wrong while filing automatically. Your complaint text is ready to submit yourself.`,
    });
    console.error('[submission]', complaintId, e);
  }
}

export const coordinatorAgent: AgentDefinition<CoordinatorInput> = {
  name: 'coordinator_agent',
  maxSteps: 10,
  stopOnTools: ['schedule_submission', 'hand_off_to_citizen'],
  system: `You coordinate Nagrik's complaint pipeline for one complaint that the Intake Agent has just created.
Steps:
1. run_jurisdiction_agent.
2. run_drafting_agent (always — even if no department was found, the citizen needs ready-to-file text).
3. If a department/portal was assigned → schedule_submission (it applies the citizen's auto-submit preference and the review window itself).
   If no department could be assigned → hand_off_to_citizen with a short, kind explanation.
Do not skip steps and do not call a step twice unless it returned an error.`,

  buildPrompt: ({ complaintId }) => `Process complaint_id ${complaintId}.`,

  buildTools(_ctx, { complaintId }) {
    return {
      run_jurisdiction_agent: tool({
        description: 'Run the Jurisdiction Agent: decides the responsible department and portal.',
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          const r = await runAgent(jurisdictionAgent, { complaint: c }, { complaintId: c.id, userId: c.user_id });
          const after = (await repo.getComplaint(complaint_id))!;
          const j = after.jurisdiction_portal_id ? await repo.getJurisdiction(after.jurisdiction_portal_id) : null;
          return {
            assigned: !!j,
            department: after.jurisdiction_department,
            trusted: j?.review_status === 'approved',
            automatable: !!(j && j.review_status === 'approved' && j.form_selectors && !j.requires_captcha),
            summary: r.text || r.toolCalls.at(-1)?.toolName,
          };
        },
      }),

      run_drafting_agent: tool({
        description: 'Run the Drafting Agent: writes the formal complaint text for the portal.',
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          await runAgent(draftingAgent, { complaintId: complaint_id }, { complaintId: complaint_id, userId: c.user_id });
          const after = (await repo.getComplaint(complaint_id))!;
          return { drafted: !!after.draft_text, subject: after.draft_subject };
        },
      }),

      schedule_submission: tool({
        description: "Queue the Submission Agent. Honors the citizen's auto-submit setting and shows a non-blocking review window before the first submission to a portal.",
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          if (!c.draft_text) return { error: 'No draft yet — run the drafting agent first.' };
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          const automatable = !!(j && j.review_status === 'approved' && j.form_selectors && !j.requires_captcha);

          if (!automatable) {
            // No browser automation will happen; let the Submission Agent record the reason right away.
            await repo.updateComplaint(c.id, { status: 'drafted' });
            submissionHooks.schedule(c.id, Date.now());
            return { scheduled: true, mode: 'manual_handoff_expected' };
          }
          // Real portals always wait for the citizen's explicit confirmation, whatever the auto-submit setting.
          if (!c.auto_submit || !j!.is_sandbox) {
            await repo.updateComplaint(c.id, { status: 'drafted', submit_after: null });
            await notifyUser(c.user_id, c.id, 'Your complaint is ready to review', `Drafted for ${c.jurisdiction_department}. Review it and tap Submit when you're happy.`);
            return { scheduled: false, awaiting_user_approval: true };
          }
          // First-ever submission by this citizen to this portal gets a visible grace window (Hold / Edit).
          const previous = (await repo.listComplaintsByUser(c.user_id)).some(
            (x) => x.id !== c.id && x.jurisdiction_portal_id === c.jurisdiction_portal_id && x.submitted_at,
          );
          const graceMs = previous ? 3000 : config.submissionGraceSeconds * 1000;
          const at = Date.now() + graceMs;
          await repo.updateComplaint(c.id, { status: 'drafted', submit_after: new Date(at).toISOString() });
          submissionHooks.schedule(c.id, at);
          return { scheduled: true, submit_in_seconds: Math.round(graceMs / 1000), first_time_for_portal: !previous };
        },
      }),

      hand_off_to_citizen: tool({
        description: 'Give the complaint back to the citizen for manual filing (with the drafted text).',
        inputSchema: z.object({ complaint_id: z.string(), reason: z.string() }),
        execute: async ({ complaint_id, reason }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          await repo.updateComplaint(c.id, { status: 'submission_failed', failure_reason: c.failure_reason ?? `[no_form_mapping] ${reason}` });
          await notifyUser(c.user_id, c.id, 'Your complaint is drafted', 'We could not auto-file this one. Open the app to copy the text and see where to submit it.');
          return { handed_off: true };
        },
      }),
    };
  },

  offlinePolicy(s) {
    const id = s.userText.match(/complaint_id (\S+)\./)![1];
    const j = s.last('run_jurisdiction_agent');
    if (!j) return { tool: 'run_jurisdiction_agent', input: { complaint_id: id } };
    if (!s.called('run_drafting_agent')) return { tool: 'run_drafting_agent', input: { complaint_id: id } };
    if (j.output.assigned) return { tool: 'schedule_submission', input: { complaint_id: id } };
    return { tool: 'hand_off_to_citizen', input: { complaint_id: id, reason: 'No verified department mapping for this location yet.' } };
  },
};
