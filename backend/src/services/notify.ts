import { config } from '../config.js';
import { repo } from '../db/index.js';

/** Stores an in-app notification and sends an Expo push if the user registered a token. */
export async function notifyUser(userId: string, complaintId: string | null, title: string, body: string) {
  const n = await repo.addNotification({ user_id: userId, complaint_id: complaintId, title, body });
  const profile = await repo.getProfile(userId);
  let push: 'sent' | 'no_token' | 'failed' = 'no_token';
  if (profile?.expo_push_token) {
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: profile.expo_push_token,
          title,
          body,
          sound: 'default',
          data: { complaintId },
          channelId: 'complaint-updates',
        }),
        signal: AbortSignal.timeout(8000),
      });
      push = res.ok ? 'sent' : 'failed';
    } catch {
      push = 'failed';
    }
  }
  return { notificationId: n.id, push };
}

/** Notifies every resident who tapped "Me too" on this complaint. */
export async function notifySupporters(complaintId: string, title: string, body: string) {
  const supporters = await repo.listSupporters(complaintId);
  await Promise.all(supporters.map((s) => notifyUser(s.user_id, complaintId, title, body).catch(() => null)));
  return supporters.length;
}

export interface EmailResult {
  delivered: boolean;
  mode: 'resend' | 'sandbox_simulated' | 'not_configured' | 'live_disabled';
  detail: string;
  recipient: string;
}

/**
 * Sends an escalation email through Resend. Guardrails:
 *  - sandbox contacts never leave the machine unless SANDBOX_ESCALATION_EMAIL is set (then redirected there)
 *  - real government inboxes are only emailed when ALLOW_LIVE_ESCALATION_EMAILS=true
 */
export async function sendEscalationEmail(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
  sandbox: boolean;
}): Promise<EmailResult> {
  let to = opts.to;
  if (opts.sandbox) {
    if (!config.sandboxEscalationEmail || !config.resendApiKey) {
      return { delivered: true, mode: 'sandbox_simulated', detail: 'Sandbox escalation recorded (no real email sent).', recipient: to };
    }
    to = config.sandboxEscalationEmail;
  } else if (!config.allowLiveEscalationEmails) {
    return {
      delivered: false,
      mode: 'live_disabled',
      detail: 'Live escalation emails are disabled on this server (ALLOW_LIVE_ESCALATION_EMAILS=false).',
      recipient: to,
    };
  }
  if (!config.resendApiKey) {
    return { delivered: false, mode: 'not_configured', detail: 'No email provider configured (RESEND_API_KEY).', recipient: to };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.escalationFromEmail,
      to: [to],
      subject: opts.subject,
      text: opts.text,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { delivered: false, mode: 'resend', detail: `Resend error ${res.status}: ${await res.text()}`, recipient: to };
  return { delivered: true, mode: 'resend', detail: 'Email accepted by Resend.', recipient: to };
}
