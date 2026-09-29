import { generateText, Output, tool } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import type { Complaint } from '../db/types.js';
import { scrapeStatus } from '../automation/portal.js';
import { notifyUser, sendEscalationEmail } from '../services/notify.js';
import { runAgent, textModel, type AgentDefinition } from '../ai/runtime.js';
import { ISSUE_LABELS } from './intake.js';

const DAY = 24 * 60 * 60 * 1000;
const daysSince = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / DAY : 0);

export function isDueForCheck(c: Complaint, force = false) {
  if (!['submitted', 'escalated'].includes(c.status)) return false;
  if (force) return true;
  if (!c.last_checked_at) return true;
  return Date.now() - new Date(c.last_checked_at).getTime() >= config.recheckIntervalHours * 60 * 60 * 1000;
}

// ───────────────────────────── per-complaint agent ─────────────────────────────

export interface MonitorInput {
  complaintId: string;
}

export const complaintMonitorAgent: AgentDefinition<MonitorInput> = {
  name: 'monitoring_agent',
  maxSteps: 12,
  system: `You are the Monitoring & Escalation Agent of Nagrik. You look after one filed civic complaint.

Procedure:
1. get_complaint_timeline.
2. If the portal supports status checks, call check_status_via_scraper.
3. Decide:
   - Resolved on the portal (or the citizen reported it resolved) → mark_resolved, then notify_user.
   - Rejected / closed without action → escalate to the next level.
   - Unchanged and days_since_last_action ≥ escalation_threshold_days → choose the next escalation level (current escalation_level + 1, never skip levels, never exceed the chain), draft_escalation, then submit_escalation, then notify_user.
   - Still within the threshold → do nothing further (optionally request_user_status_update if the portal can't be checked and it's been over half the threshold).
4. Status changes that are meaningful to the citizen (e.g. "Assigned to engineer") deserve a short notify_user. Don't spam: no notification if nothing changed.
Guardrail: submit_escalation will refuse unverified contacts — if it does, tell the citizen via notify_user that the escalation letter is ready for them to send, and stop.
Finish with a one-line summary of what you did.`,

  buildPrompt({ complaintId }) {
    return `Monitor complaint_id ${complaintId}. Escalation threshold: ${config.escalationThresholdDays} days.`;
  },

  buildTools(_ctx, { complaintId }) {
    return {
      get_complaint_timeline: tool({
        description: 'Complaint status, key dates, previous status checks, escalations so far, and the escalation chain for its department.',
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = await repo.getComplaint(complaint_id);
          if (!c) return { error: 'not found' };
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          const checks = (await repo.listStatusChecks(c.id)).slice(0, 5);
          const escalations = await repo.listEscalations(c.id);
          const lastAction = escalations[0]?.created_at ?? c.submitted_at;
          return {
            status: c.status,
            issue: c.issue_type,
            department: c.jurisdiction_department,
            tracking_id: c.tracking_id,
            portal_status: c.portal_status,
            submitted_days_ago: Number(daysSince(c.submitted_at).toFixed(1)),
            days_since_last_action: Number(daysSince(lastAction).toFixed(1)),
            escalation_threshold_days: config.escalationThresholdDays,
            escalation_level: c.escalation_level,
            status_check_supported: !!(j?.status_check_url_template && j.status_check_selectors && c.tracking_id),
            recent_checks: checks.map((s) => ({ at: s.checked_at, status: s.status_found, source: s.source })),
            escalations: escalations.map((e) => ({ level: e.escalation_level, at: e.created_at, delivery: e.delivery_status })),
            escalation_chain: (j?.escalation_contact ?? []).map((e) => ({ level: e.level, title: e.title, channel: e.channel, verified: e.verified })),
          };
        },
      }),

      check_status_via_scraper: tool({
        description: "Open the portal's status page with Playwright, enter the tracking ID and scrape the current status.",
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          if (!j?.status_check_url_template || !j.status_check_selectors || !c.tracking_id) {
            return { available: false, message: 'This portal has no automated status check (or no tracking ID).' };
          }
          if (j.review_status !== 'approved') return { available: false, message: 'Status selectors not reviewed.' };
          const r = await scrapeStatus(j.status_check_url_template, j.status_check_selectors, c.tracking_id);
          await repo.addStatusCheck({
            complaint_id: c.id,
            status_found: r.ok ? `${r.statusText}${r.remarks ? ` — ${r.remarks}` : ''}` : `check_failed: ${r.message}`,
            source: 'scraped',
            raw_snapshot: r.rawSnapshot,
          });
          const changed = r.ok && r.statusText !== c.portal_status;
          await repo.updateComplaint(c.id, { last_checked_at: new Date().toISOString(), ...(r.ok ? { portal_status: r.statusText } : {}) });
          return { ...r, rawSnapshot: undefined, previous_status: c.portal_status, changed };
        },
      }),

      draft_escalation: tool({
        description: 'Draft a formal escalation letter to the given level of the escalation chain.',
        inputSchema: z.object({ complaint_id: z.string(), escalation_level: z.number().int().min(1), context: z.string() }),
        execute: async ({ complaint_id, escalation_level, context }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          const step = j?.escalation_contact.find((e) => e.level === escalation_level);
          if (!step) return { error: `No escalation level ${escalation_level} configured.` };
          const p = await repo.getProfile(c.user_id);
          const days = Math.floor(daysSince(c.submitted_at));
          const model = textModel();
          if (model) {
            const { output } = await generateText({
              model,
              output: Output.object({ schema: z.object({ subject: z.string().max(140), body: z.string().max(2500) }) }),
              prompt: `Write a firm, polite, formal escalation letter (plain text) to "${step.title}" in India about an unresolved civic complaint.
Facts: ${context}
Original complaint subject: ${c.draft_subject}. Department: ${c.jurisdiction_department}. Reference: ${c.tracking_id ?? 'not issued'}. Filed ${days} days ago. Location: ${c.address}. Current portal status: ${c.portal_status ?? 'unknown'}.
Include: reference number, dates, that the issue remains unresolved, a specific request (inspection and action within 7 days), the original complaint text below a divider. Sign as ${p?.full_name ?? 'A concerned resident'}${p?.phone ? `, ${p.phone}` : ''}. No placeholders.
Original complaint:
${c.draft_text}`,
            });
            return { ...output, to: step.title, channel: step.channel };
          }
          const subject = `Escalation: unresolved complaint${c.tracking_id ? ` ${c.tracking_id}` : ''} – ${c.issue_type ? ISSUE_LABELS[c.issue_type] : 'civic issue'}`;
          const body = `To
The ${step.title}

Respected Sir/Madam,

Sub: Escalation of unresolved grievance${c.tracking_id ? ` (Ref. ${c.tracking_id})` : ''}

I had filed a complaint with ${c.jurisdiction_department} ${days} day(s) ago regarding the issue described below. As of today the issue remains unresolved${c.portal_status ? ` and the portal status still reads "${c.portal_status}"` : ''}.

I request you to kindly direct the concerned officials to inspect the site and resolve the issue within 7 days.

Location: ${c.address}${c.latitude != null ? `\nMap: https://maps.google.com/?q=${c.latitude},${c.longitude}` : ''}

———— Original complaint ————
${c.draft_text}

Yours faithfully,
${p?.full_name ?? 'A concerned resident'}${p?.phone ? `\nMobile: ${p.phone}` : ''}`;
          return { subject, body, to: step.title, channel: step.channel, mode: 'template' };
        },
      }),

      submit_escalation: tool({
        description: 'Send the escalation. Email contacts are sent automatically; portal contacts or unverified contacts are handed to the citizen.',
        inputSchema: z.object({ complaint_id: z.string(), escalation_level: z.number().int().min(1), subject: z.string(), body: z.string() }),
        execute: async ({ complaint_id, escalation_level, subject, body }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          const step = j?.escalation_contact.find((e) => e.level === escalation_level);
          if (!j || !step) return { error: 'No such escalation level.' };
          if (escalation_level > c.escalation_level + 1) return { error: `Cannot skip levels (current level ${c.escalation_level}).` };
          const base = { complaint_id, escalation_level, channel: step.channel, recipient: step.contact, draft_text: `${subject}\n\n${body}` };

          // Guardrail: only act on reviewed/trusted contacts from an approved mapping.
          if (!step.verified || j.review_status !== 'approved') {
            await repo.addEscalation({ ...base, action_taken: `Blocked: ${step.title} is not a verified contact. Letter prepared for the citizen.`, delivery_status: 'blocked_unverified' });
            await repo.updateComplaint(c.id, { status: 'escalated', escalation_level });
            return { sent: false, delivery_status: 'blocked_unverified', message: 'Contact not verified; handed to citizen.' };
          }
          if (step.channel === 'portal') {
            await repo.addEscalation({ ...base, action_taken: `Escalation letter prepared for ${step.title}; that portal has no verified automation, so the citizen submits it.`, delivery_status: 'manual_required' });
            await repo.updateComplaint(c.id, { status: 'escalated', escalation_level });
            return { sent: false, delivery_status: 'manual_required', portal_url: step.contact };
          }
          const p = await repo.getProfile(c.user_id);
          const r = await sendEscalationEmail({ to: step.contact, subject, text: body, replyTo: p?.email, sandbox: j.is_sandbox });
          await repo.addEscalation({
            ...base,
            recipient: r.recipient,
            action_taken: r.delivered ? `Emailed ${step.title} (${r.mode}).` : `Email not sent: ${r.detail} Letter prepared for the citizen to send.`,
            delivery_status: r.delivered ? 'sent' : 'manual_required',
          });
          await repo.updateComplaint(c.id, { status: 'escalated', escalation_level });
          return { sent: r.delivered, delivery_status: r.delivered ? 'sent' : 'manual_required', detail: r.detail };
        },
      }),

      mark_resolved: tool({
        description: 'Mark the complaint resolved.',
        inputSchema: z.object({ complaint_id: z.string(), evidence: z.string() }),
        execute: async ({ complaint_id, evidence }) => {
          await repo.updateComplaint(complaint_id, { status: 'resolved', resolved_at: new Date().toISOString() });
          return { resolved: true, evidence };
        },
      }),

      request_user_status_update: tool({
        description: "Ask the citizen whether the issue has been fixed (used when the portal can't be checked automatically).",
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          await repo.updateComplaint(c.id, { last_checked_at: new Date().toISOString() });
          return notifyUser(c.user_id, c.id, 'Is it fixed yet?', `Tap to tell us if the ${c.issue_type ? ISSUE_LABELS[c.issue_type].toLowerCase() : 'issue'} you reported has been fixed. If not, we'll escalate it.`);
        },
      }),

      notify_user: tool({
        description: 'Push + in-app notification to the citizen.',
        inputSchema: z.object({ complaint_id: z.string(), title: z.string().max(60), message: z.string().max(240) }),
        execute: async ({ complaint_id, title, message }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          return notifyUser(c.user_id, c.id, title, message);
        },
      }),
    };
  },

  offlinePolicy(s) {
    const id = s.userText.match(/complaint_id (\S+)\./)![1];
    const tl = s.last('get_complaint_timeline');
    if (!tl) return { tool: 'get_complaint_timeline', input: { complaint_id: id } };
    const t = tl.output;
    if (t.error) return { text: `Stopped: ${t.error}` };

    if (t.status_check_supported && !s.called('check_status_via_scraper')) return { tool: 'check_status_via_scraper', input: { complaint_id: id } };
    const chk = s.last('check_status_via_scraper')?.output;
    const resolved = chk?.isResolved || /user_reported/.test(JSON.stringify(t.recent_checks?.[0] ?? '')) && /resolved/i.test(t.recent_checks?.[0]?.status ?? '');

    if (resolved) {
      if (!s.called('mark_resolved')) return { tool: 'mark_resolved', input: { complaint_id: id, evidence: chk?.statusText ?? 'Reported resolved by citizen' } };
      if (!s.called('notify_user'))
        return { tool: 'notify_user', input: { complaint_id: id, title: 'Resolved 🎉', message: `${t.department} marked your complaint as resolved${chk?.remarks ? `: ${chk.remarks}` : '.'} Thank you for making your area better.` } };
      return { text: 'Complaint resolved and citizen notified.' };
    }

    const nextLevel = (t.escalation_level ?? 0) + 1;
    const hasLevel = (t.escalation_chain ?? []).some((e: any) => e.level === nextLevel);
    const due = chk?.isRejected || t.days_since_last_action >= t.escalation_threshold_days;
    if (due && hasLevel) {
      const d = s.last('draft_escalation');
      if (!d)
        return {
          tool: 'draft_escalation',
          input: { complaint_id: id, escalation_level: nextLevel, context: `No resolution after ${t.submitted_days_ago} days. Portal status: ${chk?.statusText ?? t.portal_status ?? 'unknown'}.` },
        };
      if (d.output.error) return { text: `Escalation not possible: ${d.output.error}` };
      const sub = s.last('submit_escalation');
      if (!sub) return { tool: 'submit_escalation', input: { complaint_id: id, escalation_level: nextLevel, subject: d.output.subject, body: d.output.body } };
      if (!s.called('notify_user')) {
        const sent = sub.output.sent;
        return {
          tool: 'notify_user',
          input: {
            complaint_id: id,
            title: sent ? 'Escalated ⬆️' : 'Escalation letter ready',
            message: sent
              ? `No action after ${Math.floor(t.submitted_days_ago)} days, so we escalated to ${d.output.to}.`
              : `No action after ${Math.floor(t.submitted_days_ago)} days. Your escalation letter to ${d.output.to} is ready — open the app to send it.`,
          },
        };
      }
      return { text: `Escalated to level ${nextLevel}.` };
    }

    if (chk?.changed && chk.statusText && !s.called('notify_user'))
      return { tool: 'notify_user', input: { complaint_id: id, title: 'Status update', message: `Portal status is now “${chk.statusText}”.` } };
    if (!t.status_check_supported && t.days_since_last_action >= t.escalation_threshold_days / 2 && !s.called('request_user_status_update'))
      return { tool: 'request_user_status_update', input: { complaint_id: id } };
    return { text: 'No action needed yet.' };
  },
};

// ───────────────────────────── supervisor (cron entry) ─────────────────────────────

export interface MonitorSweepInput {
  force: boolean;
  onlyComplaintId?: string;
}

export const monitorSupervisorAgent: AgentDefinition<MonitorSweepInput> = {
  name: 'monitoring_supervisor',
  maxSteps: 40,
  system: `You run the scheduled monitoring sweep. Call list_submitted_complaints_needing_check, then call run_complaint_check once for every complaint it returns. Then reply with a one-line summary.`,
  buildPrompt: ({ force, onlyComplaintId }) =>
    `Run the monitoring sweep. force=${force}${onlyComplaintId ? ` only_complaint_id=${onlyComplaintId}` : ''}`,
  buildTools(_ctx, { force, onlyComplaintId }) {
    return {
      list_submitted_complaints_needing_check: tool({
        description: 'Complaints in submitted/escalated status that are due for a recheck.',
        inputSchema: z.object({ limit: z.number().int().max(25).default(20) }),
        execute: async ({ limit }) => {
          const rows = (await repo.listComplaintsByStatus(['submitted', 'escalated']))
            .filter((c) => (onlyComplaintId ? c.id === onlyComplaintId : true))
            .filter((c) => isDueForCheck(c, force))
            .slice(0, limit);
          return { complaints: rows.map((c) => ({ complaint_id: c.id, status: c.status, submitted_at: c.submitted_at, last_checked_at: c.last_checked_at })) };
        },
      }),
      run_complaint_check: tool({
        description: 'Run the Monitoring & Escalation Agent on one complaint.',
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const r = await runAgent(complaintMonitorAgent, { complaintId: complaint_id }, { complaintId: complaint_id });
          return { summary: r.text, actions: r.toolCalls.map((t) => t.toolName) };
        },
      }),
    };
  },
  offlinePolicy(s) {
    const list = s.last('list_submitted_complaints_needing_check');
    if (!list) return { tool: 'list_submitted_complaints_needing_check', input: { limit: 20 } };
    const done = new Set(s.history.filter((h) => h.toolName === 'run_complaint_check').map((h) => h.input.complaint_id));
    const next = (list.output.complaints ?? []).find((c: any) => !done.has(c.complaint_id));
    if (next) return { tool: 'run_complaint_check', input: { complaint_id: next.complaint_id } };
    return { text: `Checked ${done.size} complaint(s).` };
  },
};
