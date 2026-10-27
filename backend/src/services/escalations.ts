import { config } from '../config.js';
import { repo } from '../db/index.js';
import type { Complaint } from '../db/types.js';
import { sendEscalationEmail } from './notify.js';

/**
 * The only path that sends an escalation email. The monitoring agent and the cron job can only
 * save drafts (delivery_status 'awaiting_approval'); this runs when the signed-in citizen approves
 * that exact draft in the app. Every rule is enforced here, not in a prompt.
 */
export class EscalationRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sending = new Set<string>();

export async function sendApprovedEscalation(opts: { complaint: Complaint; escalationId: string; userId: string; subject: string; body: string }) {
  const { complaint: c, escalationId, userId } = opts;
  if (c.user_id !== userId) throw new EscalationRefused(404, 'Complaint not found');
  const e = await repo.getEscalation(escalationId);
  if (!e || e.complaint_id !== c.id) throw new EscalationRefused(404, 'Escalation draft not found');
  if (e.delivery_status !== 'awaiting_approval') throw new EscalationRefused(409, 'This escalation is not waiting for approval.');
  // Approval covers exactly the text the citizen saw: an edit after that needs a fresh approval.
  if (e.subject !== opts.subject || e.body !== opts.body) {
    throw new EscalationRefused(409, 'The letter changed after you reviewed it. Please review it again.');
  }
  if (!['submitted', 'escalated'].includes(c.status)) throw new EscalationRefused(409, 'Only filed, unresolved complaints can be escalated.');
  if (e.escalation_level !== c.escalation_level + 1) throw new EscalationRefused(409, `Cannot skip levels (current level ${c.escalation_level}).`);

  // Re-check the contact at send time: the directory may have changed since the draft was made.
  const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
  const step = j?.escalation_contact.find((s) => s.level === e.escalation_level);
  if (!j || !step || j.review_status !== 'approved' || !step.verified || step.channel !== 'email' || step.contact !== e.recipient) {
    throw new EscalationRefused(409, 'This contact is no longer verified, so we cannot send to it.');
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if ((await repo.countApprovedEscalations(userId, since)) >= config.maxEscalationEmailsPerDay) {
    throw new EscalationRefused(429, `You can send up to ${config.maxEscalationEmailsPerDay} escalation emails a day. Please try again tomorrow.`);
  }

  if (sending.has(e.id)) throw new EscalationRefused(409, 'Already sending.');
  sending.add(e.id);
  try {
    const approvedAt = new Date().toISOString();
    const p = await repo.getProfile(c.user_id);
    const r = await sendEscalationEmail({ to: step.contact, subject: e.subject!, text: e.body!, replyTo: p?.email, sandbox: j.is_sandbox });
    const updated = await repo.updateEscalation(e.id, {
      recipient: r.recipient,
      approved_by: userId,
      approved_at: approvedAt,
      action_taken: r.delivered ? `Emailed ${step.title} (${r.mode}) after the citizen approved it.` : `Email not sent: ${r.detail} Letter prepared for the citizen to send.`,
      delivery_status: r.delivered ? 'sent' : 'manual_required',
    });
    await repo.updateComplaint(c.id, { status: 'escalated', escalation_level: e.escalation_level });
    return { escalation: updated, sent: r.delivered, detail: r.detail };
  } finally {
    sending.delete(e.id);
  }
}

export async function editEscalationDraft(complaint: Complaint, escalationId: string, subject: string, body: string) {
  const e = await repo.getEscalation(escalationId);
  if (!e || e.complaint_id !== complaint.id) throw new EscalationRefused(404, 'Escalation draft not found');
  if (e.delivery_status !== 'awaiting_approval') throw new EscalationRefused(409, 'Only drafts waiting for approval can be edited.');
  return repo.updateEscalation(e.id, { subject, body, draft_text: `${subject}\n\n${body}` });
}

export async function cancelEscalationDraft(complaint: Complaint, escalationId: string) {
  const e = await repo.getEscalation(escalationId);
  if (!e || e.complaint_id !== complaint.id) throw new EscalationRefused(404, 'Escalation draft not found');
  if (e.delivery_status !== 'awaiting_approval') throw new EscalationRefused(409, 'Only drafts waiting for approval can be cancelled.');
  return repo.updateEscalation(e.id, { delivery_status: 'cancelled', action_taken: 'Cancelled by the citizen. Nothing was sent.' });
}
