import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { repo } from '../db/index.js';
import { ISSUE_TYPES, type Complaint } from '../db/types.js';
import { requireUser } from '../auth.js';
import { runAgent } from '../ai/runtime.js';
import { intakeAgent } from '../agents/intake.js';
import { jurisdictionAgent } from '../agents/jurisdiction.js';
import { draftingAgent } from '../agents/drafting.js';
import { savePhoto } from '../services/storage.js';
import { reverseGeocode } from '../services/geocode.js';
import { humanizeLogs } from '../services/activity.js';
import { enqueueSubmission, holdSubmission, runMonitorSweep, startPipeline } from '../services/scheduler.js';

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

async function complaintDetail(c: Complaint) {
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
    status_checks: checks,
    escalations,
    activity: humanizeLogs(logs),
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
});

complaintsRouter.post('/analyze', analyzeLimiter, upload.single('photo'), async (req, res) => {
  const parsed = analyzeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  const b = parsed.data;
  if (b.latitude == null && !b.manualAddress?.trim()) {
    return res.status(400).json({ error: 'We need your location — allow location access or type the address.' });
  }

  let photoUrl = b.photoUrl;
  if (req.file) photoUrl = await savePhoto(req.userId, req.file.buffer, req.file.mimetype);
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
      autoSubmit: profile?.auto_submit_default ?? true,
    },
    { complaintId: intakeId, userId: req.userId },
  );

  const last = [...result.toolCalls].reverse().find((t) => ['save_complaint', 'ask_user_clarification', 'reject_photo'].includes(t.toolName));
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
  const rows = await repo.listComplaintsByUser(req.userId);
  res.json({ complaints: rows });
});

complaintsRouter.get('/:id/status', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (c) res.json(await complaintDetail(c));
});

// ───────────── individual agent triggers (spec endpoints) ─────────────
complaintsRouter.post('/:id/determine-jurisdiction', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (['submitting', 'submitted', 'escalated', 'resolved'].includes(c.status)) return res.status(409).json({ error: 'Already filed.' });
  await runAgent(jurisdictionAgent, { complaint: c }, { complaintId: c.id, userId: req.userId });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/draft', async (req, res) => {
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

complaintsRouter.post('/:id/submit', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (!['drafted', 'submission_failed'].includes(c.status)) return res.status(409).json({ error: `Can't submit while ${c.status}.` });
  if (!c.draft_text) return res.status(409).json({ error: 'The draft is not ready yet.' });
  await repo.updateComplaint(c.id, { status: 'drafted', submit_after: null });
  void enqueueSubmission(c.id);
  res.status(202).json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/hold', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (c.status !== 'drafted') return res.status(409).json({ error: 'Too late to hold — filing already started.' });
  await holdSubmission(c.id);
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/retry', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (c.status === 'analyzing' || !c.draft_text || !c.jurisdiction_portal_id) {
    await repo.updateComplaint(c.id, { status: 'analyzing', failure_reason: null });
    void startPipeline(c.id, req.userId);
  } else if (c.status === 'submission_failed') {
    await repo.updateComplaint(c.id, { status: 'drafted', failure_reason: null });
    void enqueueSubmission(c.id);
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
  } else {
    await repo.updateComplaint(c.id, { last_checked_at: new Date().toISOString() });
  }
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
});

complaintsRouter.post('/:id/check-status', async (req, res) => {
  const c = await ownComplaint(req, res);
  if (!c) return;
  if (!['submitted', 'escalated'].includes(c.status)) return res.status(409).json({ error: 'Only filed complaints can be checked.' });
  if (c.last_checked_at && Date.now() - new Date(c.last_checked_at).getTime() < 5 * 60 * 1000) {
    return res.status(429).json({ error: 'Checked just now — please try again in a few minutes.' });
  }
  await runMonitorSweep({ force: true, complaintId: c.id });
  res.json(await complaintDetail((await repo.getComplaint(c.id))!));
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
