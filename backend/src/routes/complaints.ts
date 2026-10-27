import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { repo } from '../db/index.js';
import { ISSUE_TYPES, type Complaint } from '../db/types.js';
import { requireUser } from '../auth.js';
import { generateText, Output } from 'ai';
import { noteGeminiError, runAgent, textModel } from '../ai/runtime.js';
import { intakeAgent } from '../agents/intake.js';
import { jurisdictionAgent } from '../agents/jurisdiction.js';
import { draftingAgent } from '../agents/drafting.js';
import { isOwnPhotoUrl, savePhoto } from '../services/storage.js';
import { reverseGeocode } from '../services/geocode.js';
import { escalationSummary, friendlyStatusCheck, humanizeLogs } from '../services/activity.js';
import { findNearby, publicView, supportedSet } from '../services/nearby.js';
import { notifySupporters, notifyUser } from '../services/notify.js';
import { enqueueSubmission, holdSubmission, runMonitorSweep, startPipeline } from '../services/scheduler.js';
import { agentActionLimiter } from '../rateLimits.js';
import { complaintMonitorAgent } from '../agents/monitoring.js';
import { cancelEscalationDraft, editEscalationDraft, EscalationRefused, sendApprovedEscalation } from '../services/escalations.js';

export const complaintsRouter = Router();
complaintsRouter.use(requireUser);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)),
});

const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => (req as Request).userId,
  message: { error: "You've reported a lot in the last hour. Please try again a little later." },
  standardHeaders: true,
  legacyHeaders: false,
});

async function ownComplaint(req: Request, res: Response): Promise<Complaint | null> {
  const c = await repo.getComplaint(String(req.params.id));
  if (!c || c.user_id !== req.userId) {
    res.status(404).json({ error: 'Complaint not found' });
    return null;
  }
  return c;
}

/** Owner or a "Me too" supporter. Supporters get a read-only, privacy-redacted view. */
async function viewableComplaint(req: Request, res: Response): Promise<{ c: Complaint; role: 'owner' | 'supporter' } | null> {
  const c = await repo.getComplaint(String(req.params.id));
  if (c && c.user_id === req.userId) return { c, role: 'owner' };
  if (c && (await repo.listSupporters(c.id)).some((s) => s.user_id === req.userId)) return { c, role: 'supporter' };
  res.status(404).json({ error: 'Complaint not found' });
  return null;
}

async function complaintDetail(c: Complaint, role: 'owner' | 'supporter' = 'owner') {
  if (role === 'supporter') {
    // The letter contains the reporter's name and mobile number.
    c = { ...c, draft_text: null, draft_subject: null, user_note: null, failure_reason: null };
  }
  const [j, checks, escalations, logs] = await Promise.all([
    c.jurisdiction_portal_id ? repo.getJurisdiction(c.jurisdiction_portal_id) : null,
    repo.listStatusChecks(c.id),
    repo.listEscalations(c.id),
    repo.listToolLogs({ complaintId: c.id, limit: 300 }),
  ]);
  const failureMatch = c.failure_reason?.match(/^\[(\w+)\]\s*(.*)$/s);
  return {
    complaint: c,
    failure: c.failure_reason ? { category: failureMatch?.[1] ?? 'other', message: failureMatch?.[2] ?? c.failure_reason } : null,
    jurisdiction: j
      ? {
          id: j.id,
          department_name: j.department_name,
          portal_url: j.portal_url,
          is_sandbox: j.is_sandbox,
          verified: j.review_status === 'approved',
          requires_captcha: j.requires_captcha,
          automated: !!(j.form_selectors && j.review_status === 'approved' && !j.requires_captcha),
          notes: j.notes,
          escalation_chain: j.escalation_contact.map((e) => ({ level: e.level, title: e.title, channel: e.channel, contact: e.contact, verified: e.verified })),
        }
      : null,
    status_checks: checks.map((s) => ({ ...s, status_found: friendlyStatusCheck(s.status_found) })),
    escalations: escalations.map((e) => ({
      ...e,
      action_taken: escalationSummary(e, j?.escalation_contact.find((s) => s.level === e.escalation_level)?.title ?? null),
    })),
    activity: role === 'owner' ? humanizeLogs(logs) : [],
    viewer_role: role,
    server_time: new Date().toISOString(),
  };
}

// ───────────── POST /complaints/analyze — Intake Agent ─────────────
const analyzeBody = z.object({
  intakeId: z.string().uuid().optional(),
  photoUrl: z.string().url().optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  manualAddress: z.string().max(300).optional(),
  note: z.string().max(500).optional(),
  clarificationAnswer: z.enum(ISSUE_TYPES).optional(),
  // Photo as base64 in a JSON body — works with every fetch implementation (multipart does not).
  photoBase64: z.string().max(14_000_000).optional(),
  photoMimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  // The citizen saw a nearby duplicate and chose "It's a different problem".
  forceNew: z.union([z.boolean(), z.enum(['true', 'false'])]).optional().transform((v) => v === true || v === 'true'),
  // Overrides the profile's auto-submit setting for this complaint (the MCP server always sends false).
  autoSubmit: z.boolean().optional(),
});

complaintsRouter.post('/analyze', analyzeLimiter, upload.single('photo'), async (req, res) => {
  const parsed = analyzeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  const b = parsed.data;
  if (b.latitude == null && !b.manualAddress?.trim()) {
    return res.status(400).json({ error: 'We need your location — allow location access or type the address.' });
  }

  if (b.photoUrl && !isOwnPhotoUrl(b.photoUrl, req.userId)) return res.status(400).json({ error: 'Please add the photo again.' });
  let photoUrl = b.photoUrl;
  if (req.file) photoUrl = await savePhoto(req.userId, req.file.buffer, req.file.mimetype);
  else if (b.photoBase64) {
    const buf = Buffer.from(b.photoBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'The photo could not be read. Please try again.' });
    if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Photo is too large (max 10 MB).' });
    photoUrl = await savePhoto(req.userId, buf, b.photoMimeType ?? 'image/jpeg');
  }
  if (!photoUrl) return res.status(400).json({ error: 'Please add a photo of the issue.' });

  const intakeId = b.intakeId ?? randomUUID();
  const existing = await repo.getComplaint(intakeId);
  if (existing) {
    if (existing.user_id !== req.userId) return res.status(409).json({ error: 'Conflict' });
    return res.json({ result: 'created', complaint: existing });
  }

  const profile = await repo.getProfile(req.userId);
  const result = await runAgent(
    intakeAgent,
    {
      intakeId,
      userId: req.userId,
      photoUrl,
      latitude: b.latitude ?? null,
      longitude: b.longitude ?? null,
      manualAddress: b.manualAddress?.trim() || null,
      userNote: b.note?.trim() || null,
      clarificationAnswer: b.clarificationAnswer ?? null,
      autoSubmit: b.autoSubmit ?? profile?.auto_submit_default ?? true,
      forceNew: b.forceNew,
    },
    { complaintId: intakeId, userId: req.userId },
  );

  const last = [...result.toolCalls]
    .reverse()
    .find((t) => ['save_complaint', 'ask_user_clarification', 'reject_photo', 'suggest_join_existing'].includes(t.toolName) && !(t.output as { error?: string })?.error);
  if (last?.toolName === 'suggest_join_existing') {
    const o = last.output as { complaint_id: string; reason: string };
    const dup = await repo.getComplaint(o.complaint_id);
    if (dup) {
      const view = publicView(dup, { userId: req.userId, supported: await supportedSet(req.userId) });
      return res.json({ result: 'duplicate', intakeId, photoUrl, reason: o.reason, existing: view });
    }
  }
  if (last?.toolName === 'ask_user_clarification') {
    const o = last.output as { question: string; options: Array<{ issue_type: string; label: string }> };
    return res.json({ result: 'clarification', intakeId, photoUrl, question: o.question, options: o.options });
  }
  if (last?.toolName === 'reject_photo') {
    return res.json({ result: 'rejected', intakeId, photoUrl, reason: (last.output as { reason: string }).reason });
  }
  const complaint = await repo.getComplaint(intakeId);
  if (!complaint) {
    return res.status(502).json({ error: "Our assistant couldn't finish analyzing this photo. Please try again.", intakeId, photoUrl });
  }
  // Autonomous from here: routing → drafting → submission run in the background.
  void startPipeline(complaint.id, req.userId);
  res.status(201).json({ result: 'created', complaint });
});

// ───────────── address preview for the report screen ─────────────
const geocodeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, keyGenerator: (req) => (req as Request).userId, standardHeaders: true, legacyHeaders: false });
complaintsRouter.get('/geocode', geocodeLimiter, async (req, res) => {
  const q = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'lat and lng required' });
  try {
    const g = await reverseGeocode(q.data.lat, q.data.lng);
    res.json({ label: [g.locality, g.city].filter(Boolean).join(', ') || g.address, ...g });
  } catch {
    res.status(502).json({ error: 'Address lookup unavailable' });
  }
});

// ───────────── list + detail ─────────────
complaintsRouter.get('/', async (req, res) => {
  const [own, supported] = await Promise.all([repo.listComplaintsByUser(req.userId), repo.listSupportedComplaints(req.userId)]);
  const redact = (c: Complaint) => ({ ...c, draft_text: null, draft_subject: null, user_note: null, viewer_role: 'supporter' as const });
  const rows = [...own.map((c) => ({ ...c, viewer_role: 'owner' as const })), ...supported.filter((c) => c.user_id !== req.userId).map(redact)];
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ complaints: rows });
});

// ───────────── Nearby map ─────────────
complaintsRouter.get('/nearby', async (req, res) => {
  const q = z
    .object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), radius: z.coerce.number().min(100).max(10000).default(3000) })
    .safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'lat and lng required' });
  const hits = await findNearby(q.data.lat, q.data.lng, q.data.radius, { limit: 200 });
  const supported = await supportedSet(req.userId);
  res.json({ items: hits.map(({ c, distance }) => publicView(c, { userId: req.userId, supported }, distance)) });
});

// ───────────── "Me too" ─────────────
const SUPPORT_MILESTONES = new Set([1, 5, 10, 25, 50, 100]);
complaintsRouter.post('/:id/support', agentActionLimiter, async (req, res) => {
  const c = await repo.getComplaint(String(req.params.id));
  if (!c || c.status === 'analyzing') return res.status(404).json({ error: 'Complaint not found' });
  if (c.user_id === req.userId) return res.status(409).json({ error: 'You reported this one yourself.' });
  const added = await repo.addSupporter(c.id, req.userId);
  const updated = (await repo.getComplaint(c.id))!;
  if (added && SUPPORT_MILESTONES.has(updated.supporters_count)) {
    const n = updated.supporters_count;
    await notifyUser(c.user_id, c.id, n === 1 ? 'A neighbour joined your complaint' : `${n} neighbours joined your complaint`, `${n + 1} residents are now affected. We'll mention this in follow-ups and escalations.`);
  }
  res.json({ supported: true, supporters_count: updated.supporters_count });
});

complaintsRouter.delete('/:id/support', async (req, res) => {
  const c = await repo.getComplaint(String(req.params.id));
  if (!c) return res.status(404).json({ error: 'Complaint not found' });
  await repo.removeSupporter(c.id, req.userId);
  const updated = (await repo.getComplaint(c.id))!;
  res.json({ supported: false, supporters_count: updated.supporters_count });
});

// ───────────── Voice → text (Telugu / Hindi / English) ─────────────
const transcribeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 40, keyGenerator: (req) => (req as Request).userId, standardHeaders: true, legacyHeaders: false });
complaintsRouter.post('/transcribe', transcribeLimiter, async (req, res) => {
  const b = z
    .object({ audioBase64: z.string().min(100).max(8_000_000), mimeType: z.string().max(40).default('audio/mp4'), lang: z.enum(['en', 'te', 'hi']).default('en') })
    .safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: 'Invalid audio' });
  const model = textModel();
  if (!model) return res.status(503).json({ error: 'Voice input is unavailable right now. Please type instead.' });
  const audio = Buffer.from(b.data.audioBase64, 'base64');
  const run = (mediaType: string) =>
    generateText({
      model,
      maxRetries: 1,
      output: Output.object({
        schema: z.object({
          transcript: z.string().describe('Exactly what was said, in the original language and script.'),
          english: z.string().describe('Faithful English translation (same as transcript if already English).'),
          language: z.enum(['en', 'te', 'hi', 'other']),
        }),
      }),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'A resident of Telangana, India is describing a civic problem (pothole, garbage, street light, water leak, drainage…). Transcribe it and translate to English. If there is no speech, return empty strings.' },
            { type: 'file', data: audio, mediaType },
          ],
        },
      ],
    });
  try {
    let out;
    try {
      out = (await run(b.data.mimeType)).output;
    } catch (e) {
      // Some Gemini versions reject "audio/mp4" for .m4a; AAC is the same codec.
      if (/mime|media type|unsupported/i.test(String((e as Error).message))) out = (await run('audio/aac')).output;
      else throw e;
    }
    if (!out.transcript.trim()) return res.status(422).json({ error: "We couldn't hear anything. Please try again closer to the phone." });
    res.json(out);
  } catch (e) {
    noteGeminiError(e);
    console.warn('[transcribe]', (e as Error).message);
    res.status(503).json({ error: 'Voice input is unavailable right now. Please type instead.' });
  }
});

complaintsRouter.get('/:id/status', async (req, res) => {
  const v = await viewableComplaint(req, res);
  if (v) res.json(await complaintDetail(v.c, v.role));
});

// ───────────── individual agent triggers (spec endpoints) ─────────────
complaintsRouter.post('/:id/determine-jurisdiction', agentActionLimiter, async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (['submitting', 'submitted', 'escalated', 'resolved'].includes(c.status)) return res.status(409).json({ error: 'Already filed.' });
  await runAgent(jurisdictionAgent, { complaint: c }, { complaintId: c.id, userId: req.userId });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/draft', agentActionLimiter, async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (['submitting', 'submitted', 'escalated', 'resolved'].includes(c.status)) return res.status(409).json({ error: 'Already filed.' });
  await holdSubmission(c.id);
  await runAgent(draftingAgent, { complaintId: c.id }, { complaintId: c.id, userId: req.userId });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.patch('/:id/draft', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  const body = z.object({ subject: z.string().min(5).max(100), text: z.string().min(50).max(1500) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Subject must be 5–100 characters and the text 50–1500 characters.' });
  if (!['drafted', 'submission_failed'].includes(c.status)) return res.status(409).json({ error: 'This complaint can no longer be edited.' });
  await holdSubmission(c.id);
  await repo.updateComplaint(c.id, { draft_subject: body.data.subject, draft_text: body.data.text });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/submit', agentActionLimiter, async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (!['drafted', 'submission_failed'].includes(c.status)) return res.status(409).json({ error: `Can't submit while ${c.status}.` });
  if (!c.draft_text) return res.status(409).json({ error: 'The draft is not ready yet.' });
  await repo.updateComplaint(c.id, { status: 'drafted', submit_after: null });
  void enqueueSubmission(c.id, true);
  res.status(202).json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/hold', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (c.status !== 'drafted') return res.status(409).json({ error: 'Too late to hold — filing already started.' });
  await holdSubmission(c.id);
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/retry', agentActionLimiter, async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (c.status === 'analyzing' || !c.draft_text || !c.jurisdiction_portal_id) {
    await repo.updateComplaint(c.id, { status: 'analyzing', failure_reason: null });
    void startPipeline(c.id, req.userId);
  } else if (c.status === 'submission_failed') {
    await repo.updateComplaint(c.id, { status: 'drafted', failure_reason: null });
    void enqueueSubmission(c.id, true);
  } else {
    return res.status(409).json({ error: 'Nothing to retry.' });
  }
  res.status(202).json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/manual-submitted', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  const body = z.object({ trackingId: z.string().trim().max(60).optional() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'Invalid reference number' });
  if (!['drafted', 'submission_failed'].includes(c.status)) return res.status(409).json({ error: 'Already filed.' });
  await holdSubmission(c.id);
  await repo.updateComplaint(c.id, {
    status: 'submitted',
    tracking_id: body.data.trackingId || null,
    submitted_at: new Date().toISOString(),
    portal_status: 'Filed by citizen',
  });
  await repo.addStatusCheck({ complaint_id: c.id, status_found: 'Filed manually by citizen', source: 'user_reported', raw_snapshot: null });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/user-status', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  const body = z.object({ resolved: z.boolean(), note: z.string().max(300).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid request' });
  if (!['submitted', 'escalated'].includes(c.status)) return res.status(409).json({ error: 'Only filed complaints can be updated.' });
  await repo.addStatusCheck({
    complaint_id: c.id,
    status_found: body.data.resolved ? `Resolved (reported by citizen)${body.data.note ? ` — ${body.data.note}` : ''}` : `Not resolved yet (reported by citizen)${body.data.note ? ` — ${body.data.note}` : ''}`,
    source: 'user_reported',
    raw_snapshot: null,
  });
  if (body.data.resolved) {
    await repo.updateComplaint(c.id, { status: 'resolved', resolved_at: new Date().toISOString() });
    await notifySupporters(c.id, 'Fixed 🎉', 'The reporter confirmed that an issue you supported has been fixed.');
  } else {
    await repo.updateComplaint(c.id, { last_checked_at: new Date().toISOString() });
  }
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/check-status', agentActionLimiter, async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (!['submitted', 'escalated'].includes(c.status)) return res.status(409).json({ error: 'Only filed complaints can be checked.' });
  if (c.last_checked_at && Date.now() - new Date(c.last_checked_at).getTime() < 5 * 60 * 1000) {
    return res.status(429).json({ error: 'Checked just now — please try again in a few minutes.' });
  }
  await runMonitorSweep({ force: true, complaintId: c.id });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

// Citizen-requested escalation. Explicit confirm required; real offices also need a minimum wait so
// officials aren't escalated to the day after filing. This only prepares the letter: an email is
// sent later through /escalations/:eid/send, once the citizen approves the exact text.
const MIN_DAYS_BEFORE_MANUAL_ESCALATION = 3;
complaintsRouter.post('/:id/escalate', agentActionLimiter, async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Escalation needs explicit confirmation (confirm: true).' });
  if (!['submitted', 'escalated'].includes(c.status)) return res.status(409).json({ error: 'Only filed, unresolved complaints can be escalated.' });
  const escalations = await repo.listEscalations(c.id);
  // Already drafted: show the existing draft for review instead of making another.
  if (escalations.some((e) => e.delivery_status === 'awaiting_approval')) return res.json(await complaintDetail(c));
  const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
  const lastAction = escalations[0]?.created_at ?? c.submitted_at;
  const days = lastAction ? (Date.now() - new Date(lastAction).getTime()) / 86_400_000 : 0;
  if (!j?.is_sandbox && days < MIN_DAYS_BEFORE_MANUAL_ESCALATION) {
    return res.status(409).json({ error: `Please give the office at least ${MIN_DAYS_BEFORE_MANUAL_ESCALATION} days before escalating.` });
  }
  await runAgent(complaintMonitorAgent, { complaintId: c.id, citizenRequestedEscalation: true }, { complaintId: c.id, userId: req.userId });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

// ───────────── escalation drafts: the citizen reviews, edits, sends or cancels ─────────────
const draftBody = z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(20).max(6000) });

async function escalationAction(req: Request, res: Response, act: (c: Complaint, eid: string) => Promise<unknown>) {
  const c = await ownComplaint(req, res);
  if (!c) return;
  try {
    await act(c, String(req.params.eid));
  } catch (e) {
    if (e instanceof EscalationRefused) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
}

complaintsRouter.patch('/:id/escalations/:eid', async (req, res) => {
  const body = draftBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid letter' });
  await escalationAction(req, res, (c, eid) => editEscalationDraft(c, eid, body.data.subject, body.data.body));
});

// The citizen's approval: confirm plus the exact subject and body they reviewed.
complaintsRouter.post('/:id/escalations/:eid/send', agentActionLimiter, async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Sending needs explicit confirmation (confirm: true).' });
  const body = draftBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Send the subject and body you approved.' });
  await escalationAction(req, res, (c, eid) => sendApprovedEscalation({ complaint: c, escalationId: eid, userId: req.userId, ...body.data }));
});

complaintsRouter.post('/:id/escalations/:eid/cancel', async (req, res) => {
  await escalationAction(req, res, (c, eid) => cancelEscalationDraft(c, eid));
});

complaintsRouter.delete('/:id', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (!['analyzing', 'drafted', 'submission_failed'].includes(c.status)) {
    return res.status(409).json({ error: 'Filed complaints cannot be deleted. You can mark them resolved instead.' });
  }
  await holdSubmission(c.id);
  await repo.deleteComplaint(c.id);
  res.status(204).end();
});
