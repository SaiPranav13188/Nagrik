import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import { repo } from '../db/index.js';
import type { Complaint, Jurisdiction, Profile } from '../db/types.js';
import { textModel, type AgentDefinition } from '../ai/runtime.js';
import { ISSUE_LABELS } from './intake.js';

export interface DraftingInput {
  complaintId: string;
}

const draftSchema = z.object({
  subject: z.string().max(100),
  body: z.string().max(1500),
});

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

export function templateDraft(c: Complaint, j: Jurisdiction | null, p: Profile | null) {
  const label = c.issue_type ? ISSUE_LABELS[c.issue_type] : 'Civic issue';
  const place = c.address?.split(',').slice(0, 2).join(',').trim() || 'my locality';
  const subject = `${label} at ${place}`.slice(0, 100);
  const urgent = c.severity === 'high' ? ' This poses an immediate safety risk to residents and commuters, and urgent attention is requested.' : '';
  const gps = c.latitude != null ? `\nGPS: ${c.latitude.toFixed(6)}, ${c.longitude!.toFixed(6)} (https://maps.google.com/?q=${c.latitude},${c.longitude})` : '';
  const body = `To
The ${j?.department_name ?? 'Concerned Officer'}

Respected Sir/Madam,

I wish to bring to your attention the following issue observed on ${formatDate(c.created_at)}.

${c.description}${urgent}

Location: ${c.address ?? 'Not available'}${gps}

A photograph of the issue is attached for reference. I kindly request you to inspect the site and take necessary action at the earliest.

Thank you.

Yours faithfully,
${p?.full_name ?? 'A concerned resident'}${p?.phone ? `\nMobile: ${p.phone}` : ''}`;
  return { subject, body: body.slice(0, 1500) };
}

export const draftingAgent: AgentDefinition<DraftingInput> = {
  name: 'drafting_agent',
  maxSteps: 6,
  stopOnTools: ['save_draft'],
  system: `You are the Drafting Agent of Nagrik. Produce a formal, concise complaint ready to paste into a government grievance portal.
Procedure: call get_complaint_context, then draft_complaint_text (pass the portal requirements you found in the context), review the draft for accuracy against the context (no invented facts, correct department, correct location, within length limits), then call save_draft.`,

  buildPrompt({ complaintId }) {
    return `Draft the complaint for complaint_id ${complaintId}.`;
  },

  buildTools(_ctx, { complaintId }) {
    return {
      get_complaint_context: tool({
        description: 'Fetch the complaint, the assigned department/portal (with its format requirements), and the citizen contact details.',
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = await repo.getComplaint(complaint_id);
          if (!c) return { error: 'not found' };
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          const p = await repo.getProfile(c.user_id);
          return {
            complaint: {
              id: c.id,
              issue_type: c.issue_type,
              severity: c.severity,
              description: c.description,
              user_note: c.user_note,
              address: c.address,
              latitude: c.latitude,
              longitude: c.longitude,
              reported_on: formatDate(c.created_at),
            },
            department: j?.department_name ?? null,
            portal_requirements: j?.notes ?? 'Formal English, subject under 100 chars, body under 1500 chars.',
            citizen: { name: p?.full_name ?? null, phone: p?.phone ?? null },
          };
        },
      }),

      draft_complaint_text: tool({
        description: "Generate the complaint subject and body in the structure the portal expects.",
        inputSchema: z.object({
          context: z.string().describe('Key facts: issue, description, location, department, citizen name/phone.'),
          portal_requirements: z.string(),
        }),
        execute: async ({ context, portal_requirements }) => {
          const model = textModel();
          const c = (await repo.getComplaint(complaintId))!;
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          const p = await repo.getProfile(c.user_id);
          if (!model) return { ...templateDraft(c, j, p), mode: 'template' };
          const { output } = await generateText({
            model,
            output: Output.object({ schema: draftSchema }),
            prompt: `Write a formal civic complaint for an Indian municipal grievance portal.
Requirements from the portal: ${portal_requirements}
Facts (use ONLY these, do not invent): ${context}
Structure: "To / The <department>" line, respectful salutation, what the issue is, exact location (with Google Maps link if GPS known), since when / date reported, safety impact if any, a clear request for action, closing with the citizen's name and mobile.
Plain text only. No markdown, no placeholders like [Name] — if a detail is unknown, omit it.`,
          });
          return { ...output, mode: 'llm' };
        },
      }),

      save_draft: tool({
        description: 'Persist the final draft. Ends this agent run.',
        inputSchema: z.object({ complaint_id: z.string(), subject: z.string().max(100), draft_text: z.string().min(50).max(1500) }),
        execute: async ({ complaint_id, subject, draft_text }) => {
          const c = await repo.getComplaint(complaint_id);
          const keepStatus = c && !['analyzing', 'drafted'].includes(c.status);
          await repo.updateComplaint(complaint_id, { draft_subject: subject, draft_text, ...(keepStatus ? {} : { status: 'drafted' }) });
          return { saved: true };
        },
      }),
    };
  },

  offlinePolicy(s) {
    const id = s.userText.match(/complaint_id (\S+)\./)![1];
    const ctx = s.last('get_complaint_context');
    if (!ctx) return { tool: 'get_complaint_context', input: { complaint_id: id } };
    const d = s.last('draft_complaint_text');
    if (!d) {
      const o = ctx.output;
      return {
        tool: 'draft_complaint_text',
        input: {
          context: JSON.stringify(o.complaint) + ` Department: ${o.department}. Citizen: ${o.citizen?.name}, ${o.citizen?.phone}`,
          portal_requirements: o.portal_requirements,
        },
      };
    }
    return { tool: 'save_draft', input: { complaint_id: id, subject: d.output.subject, draft_text: d.output.body } };
  },
};
