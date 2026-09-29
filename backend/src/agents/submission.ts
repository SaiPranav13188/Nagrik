import fs from 'node:fs';
import { tool } from 'ai';
import { z } from 'zod';
import { repo } from '../db/index.js';
import { detectCaptcha } from '../automation/captcha.js';
import { extractConfirmationDetails, fillAndSubmitForm, getSnapshot } from '../automation/portal.js';
import { photoToTempFile } from '../services/storage.js';
import { notifyUser } from '../services/notify.js';
import type { AgentDefinition } from '../ai/runtime.js';

export interface SubmissionInput {
  complaintId: string;
}

export const FAILURE_CATEGORIES = ['captcha', 'otp_gate', 'selector_mismatch', 'portal_error', 'unverified_portal', 'no_form_mapping', 'missing_citizen_details', 'navigation_failed'] as const;

export const submissionAgent: AgentDefinition<SubmissionInput> = {
  name: 'submission_agent',
  maxSteps: 10,
  stopOnTools: ['mark_submitted', 'flag_submission_failure'],
  system: `You are the Submission Agent of Nagrik. You file a drafted complaint on the government portal using browser automation.

Procedure:
1. get_form_selectors for the complaint's portal. If it reports the portal is not approved, has no form mapping, needs a CAPTCHA/OTP, or citizen details are missing → call flag_submission_failure immediately with the right category. Do not attempt automation.
2. Otherwise call fill_and_submit_form once.
3. If the outcome is blocked_by_captcha → call detect_captcha on the snapshot to record evidence, then flag_submission_failure (category captcha or otp_gate). NEVER try to solve or bypass a CAPTCHA/OTP.
4. If the outcome is selector_mismatch / portal_error / navigation_failed → flag_submission_failure with that category. Do not retry more than once, and never submit a partially filled form.
5. If submitted → call extract_confirmation_details on the snapshot, then mark_submitted with the tracking ID (or null if none was shown).
Every failure hands the complaint back to the citizen with the drafted text and portal link, so be specific and plain-spoken in the reason.`,

  buildPrompt({ complaintId }) {
    return `Submit complaint_id ${complaintId}.`;
  },

  buildTools(_ctx, { complaintId }) {
    return {
      get_form_selectors: tool({
        description: "Load the reviewed Playwright field mapping for the complaint's portal, plus readiness checks.",
        inputSchema: z.object({ complaint_id: z.string() }),
        execute: async ({ complaint_id }) => {
          const c = await repo.getComplaint(complaint_id);
          if (!c) return { error: 'complaint not found' };
          if (!c.jurisdiction_portal_id) return { ready: false, blocker: 'no_form_mapping', detail: 'No portal assigned.' };
          const j = await repo.getJurisdiction(c.jurisdiction_portal_id);
          if (!j) return { ready: false, blocker: 'no_form_mapping', detail: 'Portal record missing.' };
          const p = await repo.getProfile(c.user_id);
          const base = { portal_id: j.id, portal_url: j.portal_url, department: j.department_name, is_sandbox: j.is_sandbox };
          // Guardrail: only admin-approved portals with reviewed selectors may be auto-submitted.
          if (j.review_status !== 'approved') return { ...base, ready: false, blocker: 'unverified_portal', detail: 'This department mapping is still awaiting admin verification.' };
          if (j.requires_captcha) return { ...base, ready: false, blocker: 'otp_gate', detail: 'Portal requires human verification (CAPTCHA/OTP) before the form.', notes: j.notes };
          if (!j.form_selectors) return { ...base, ready: false, blocker: 'no_form_mapping', detail: 'No reviewed form mapping for this portal yet.' };
          if (!p?.full_name || !p?.phone) return { ...base, ready: false, blocker: 'missing_citizen_details', detail: 'Citizen name/phone missing from profile.' };
          if (!c.draft_text) return { ...base, ready: false, blocker: 'portal_error', detail: 'No draft saved.' };
          return { ...base, ready: true, field_count: j.form_selectors.fields.length, fields: j.form_selectors.fields.map((f) => f.source) };
        },
      }),

      fill_and_submit_form: tool({
        description: 'Open the portal in headless Chromium, fill each mapped field (including the photo), and submit. Returns an outcome and a page snapshot id.',
        inputSchema: z.object({ complaint_id: z.string(), portal_url: z.string() }),
        execute: async ({ complaint_id, portal_url }) => {
          const c = (await repo.getComplaint(complaint_id))!;
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          // Guardrail re-checked at execution time — the model cannot talk its way past it.
          if (!j || j.review_status !== 'approved' || !j.form_selectors) return { outcome: 'refused', message: 'Portal not approved or not mapped.' };
          if (portal_url !== j.portal_url) return { outcome: 'refused', message: 'portal_url does not match the reviewed mapping.' };
          const p = await repo.getProfile(c.user_id);
          let photoPath: string | null = null;
          try {
            if (c.photo_url) photoPath = await photoToTempFile(c.photo_url);
          } catch {
            photoPath = null;
          }
          try {
            const r = await fillAndSubmitForm(j.portal_url, j.form_selectors, {
              citizen_name: p?.full_name,
              phone: p?.phone,
              email: p?.email,
              issue_type: c.issue_type,
              subject: c.draft_subject ?? c.issue_type,
              description: c.draft_text,
              address: c.address,
              latitude: c.latitude,
              longitude: c.longitude,
              photo_path: photoPath,
            });
            return r;
          } finally {
            if (photoPath) fs.rm(photoPath, () => {});
          }
        },
      }),

      detect_captcha: tool({
        description: 'Inspect a page snapshot for CAPTCHA / OTP / human-verification challenges.',
        inputSchema: z.object({ snapshot_id: z.string() }),
        execute: async ({ snapshot_id }) => {
          const snap = getSnapshot(snapshot_id);
          if (!snap) return { error: 'snapshot expired' };
          return { ...detectCaptcha(snap.html), page_title: snap.title, screenshot: snap.screenshotPath };
        },
      }),

      extract_confirmation_details: tool({
        description: 'Scrape the confirmation page snapshot for the tracking / grievance reference number.',
        inputSchema: z.object({ snapshot_id: z.string() }),
        execute: async ({ snapshot_id }) => {
          const c = (await repo.getComplaint(complaintId))!;
          const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
          return extractConfirmationDetails(snapshot_id, j?.form_selectors?.confirmation);
        },
      }),

      mark_submitted: tool({
        description: 'Record a successful submission and notify the citizen. Ends this run.',
        inputSchema: z.object({ complaint_id: z.string(), tracking_id: z.string().nullable() }),
        execute: async ({ complaint_id, tracking_id }) => {
          const c = await repo.updateComplaint(complaint_id, {
            status: 'submitted',
            tracking_id,
            submitted_at: new Date().toISOString(),
            failure_reason: null,
            portal_status: 'Registered',
          });
          await repo.addStatusCheck({ complaint_id, status_found: 'Registered (confirmation page)', source: 'scraped', raw_snapshot: null });
          await notifyUser(
            c.user_id,
            c.id,
            'Complaint filed ✅',
            tracking_id ? `Filed with ${c.jurisdiction_department}. Reference: ${tracking_id}. We'll keep tracking it for you.` : `Filed with ${c.jurisdiction_department}. We'll keep tracking it for you.`,
          );
          return { recorded: true };
        },
      }),

      flag_submission_failure: tool({
        description: 'Hand the complaint back to the citizen for manual submission (drafted text + portal link shown in the app). Ends this run.',
        inputSchema: z.object({
          complaint_id: z.string(),
          category: z.enum(FAILURE_CATEGORIES),
          reason: z.string().describe('Plain-language explanation for the citizen.'),
        }),
        execute: async ({ complaint_id, category, reason }) => {
          const c = await repo.updateComplaint(complaint_id, { status: 'submission_failed', failure_reason: `[${category}] ${reason}` });
          await notifyUser(
            c.user_id,
            c.id,
            category === 'missing_citizen_details' ? 'Add your details to file this' : 'One quick step needed from you',
            category === 'missing_citizen_details'
              ? 'The portal needs your name and mobile number. Add them in Profile and tap Retry.'
              : category === 'otp_gate'
                ? 'Your complaint is written. The portal sends an OTP to your mobile, so it needs you — open the app to copy the text and submit in under a minute.'
                : category === 'captcha'
                  ? 'Your complaint is written. The portal shows a CAPTCHA, which we never bypass — open the app to copy the text and submit in under a minute.'
                  : 'Your complaint is written but could not be filed automatically — open the app to copy the text and submit it yourself.',
          );
          return { flagged: true, category };
        },
      }),
    };
  },

  offlinePolicy(s) {
    const id = s.userText.match(/complaint_id (\S+)\./)![1];
    const sel = s.last('get_form_selectors');
    if (!sel) return { tool: 'get_form_selectors', input: { complaint_id: id } };
    const o = sel.output;
    if (o.error) return { tool: 'flag_submission_failure', input: { complaint_id: id, category: 'portal_error', reason: o.error } };
    if (!o.ready) {
      const reasons: Record<string, string> = {
        otp_gate: `${o.department}'s portal asks for a one-time password sent to your mobile before it accepts complaints, so it can't be filed automatically. Your complaint text is ready to paste.`,
        unverified_portal: 'We found the likely department, but this portal has not been verified by our team yet, so we will not file automatically. You can file it yourself using the ready text.',
        no_form_mapping: 'This portal is not yet supported for automatic filing. Your complaint text is ready to paste.',
        missing_citizen_details: 'The portal requires your name and mobile number.',
        portal_error: o.detail,
      };
      return { tool: 'flag_submission_failure', input: { complaint_id: id, category: o.blocker, reason: reasons[o.blocker] ?? o.detail } };
    }
    const sub = s.last('fill_and_submit_form');
    if (!sub) return { tool: 'fill_and_submit_form', input: { complaint_id: id, portal_url: o.portal_url } };
    const r = sub.output;
    if (r.outcome === 'blocked_by_captcha') {
      if (!s.called('detect_captcha') && r.snapshotId) return { tool: 'detect_captcha', input: { snapshot_id: r.snapshotId } };
      const kind = s.last('detect_captcha')?.output?.kind ?? r.captcha?.kind;
      return {
        tool: 'flag_submission_failure',
        input: {
          complaint_id: id,
          category: kind === 'otp_gate' ? 'otp_gate' : 'captcha',
          reason: 'The portal asked for a human-verification step (CAPTCHA). We never bypass these — please complete the submission yourself; the text is ready to paste.',
        },
      };
    }
    if (r.outcome !== 'submitted') {
      const cat = ['selector_mismatch', 'portal_error', 'navigation_failed'].includes(r.outcome) ? r.outcome : 'portal_error';
      return { tool: 'flag_submission_failure', input: { complaint_id: id, category: cat, reason: `Automatic filing didn't go through (${r.message}). Please submit it yourself using the ready text.` } };
    }
    const conf = s.last('extract_confirmation_details');
    if (!conf) return { tool: 'extract_confirmation_details', input: { snapshot_id: r.snapshotId } };
    return { tool: 'mark_submitted', input: { complaint_id: id, tracking_id: conf.output.trackingId ?? null } };
  },
};
