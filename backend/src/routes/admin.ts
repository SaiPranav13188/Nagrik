import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { z } from 'zod';
import { repo } from '../db/index.js';
import { requireAdmin, requireCron } from '../auth.js';
import { runMonitorSweep } from '../services/scheduler.js';
import { sandboxAdminRouter } from '../sandboxPortal/router.js';
import { safeError } from '../services/log.js';

export const adminRouter = Router();
const here = path.dirname(fileURLToPath(import.meta.url));

// Admin console (static page; all data calls require the admin key).
adminRouter.get('/', (_req, res) => {
  res.type('html').send(fs.readFileSync(path.join(here, '..', 'admin', 'index.html'), 'utf8'));
});

adminRouter.use(express.json({ limit: '1mb' }));
adminRouter.use('/sandbox', requireAdmin, sandboxAdminRouter);

adminRouter.get('/jurisdictions', requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? (req.query.status as 'approved' | 'pending' | 'rejected') : undefined;
  res.json({ jurisdictions: await repo.listJurisdictions(status) });
});

const selectorsSchema = z.object({
  version: z.number(),
  verified_at: z.string().optional(),
  ready: z.string().optional(),
  fields: z.array(
    z.object({
      source: z.string(),
      selector: z.string(),
      type: z.enum(['text', 'textarea', 'select', 'checkbox', 'file', 'hidden']),
      required: z.boolean().optional(),
      valueMap: z.record(z.string(), z.string()).optional(),
      constant: z.string().optional(),
    }),
  ),
  submit: z.string(),
  confirmation: z.object({
    success_selector: z.string().optional(),
    tracking_id_selector: z.string().optional(),
    tracking_id_regex: z.string().optional(),
  }),
});

/**
 * POST /admin/jurisdiction/review — the only path by which a mapping (or its form selectors /
 * escalation contacts) becomes trusted for autonomous submission.
 */
adminRouter.post('/jurisdiction/review', requireAdmin, async (req, res) => {
  const body = z
    .object({
      id: z.string(),
      decision: z.enum(['approve', 'reject']),
      comment: z.string().max(500).optional(),
      department_name: z.string().optional(),
      portal_url: z.string().url().optional(),
      requires_captcha: z.boolean().optional(),
      form_selectors: selectorsSchema.nullable().optional(),
      escalation_contact: z
        .array(z.object({ level: z.number().int(), title: z.string(), channel: z.enum(['email', 'portal']), contact: z.string(), verified: z.boolean() }))
        .optional(),
      notes: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid review', details: body.error.issues });
  const { id, decision, comment, ...edits } = body.data;
  const j = await repo.getJurisdiction(id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  const updated = await repo.updateJurisdiction(id, {
    ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)),
    review_status: decision === 'approve' ? 'approved' : 'rejected',
    reviewed_at: new Date().toISOString(),
    review_comment: comment ?? null,
  });
  await repo.addToolLog({
    agent_name: 'admin',
    complaint_id: null,
    tool_name: 'jurisdiction_review',
    arguments: { id, decision, comment, edited: Object.keys(edits) },
    result: { review_status: updated.review_status },
    duration_ms: null,
    error: null,
  });
  res.json({ jurisdiction: updated });
});

adminRouter.get('/logs', requireAdmin, async (req, res) => {
  const logs = await repo.listToolLogs({
    complaintId: typeof req.query.complaintId === 'string' ? req.query.complaintId : undefined,
    toolName: typeof req.query.tool === 'string' ? req.query.tool : undefined,
    limit: Math.min(Number(req.query.limit) || 200, 1000),
  });
  res.json({ logs });
});

/** Evaluation metrics: how much of real-world submission is actually automatable. */
adminRouter.get('/stats', requireAdmin, async (_req, res) => {
  const submits = await repo.listToolLogs({ toolName: 'fill_and_submit_form', limit: 1000 });
  const flags = await repo.listToolLogs({ toolName: 'flag_submission_failure', limit: 1000 });
  const outcomes: Record<string, number> = {};
  for (const l of submits) {
    const o = (l.result as { outcome?: string } | null)?.outcome ?? 'error';
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  const fallbackReasons: Record<string, number> = {};
  for (const l of flags) {
    const c = (l.arguments as { category?: string } | null)?.category ?? 'unknown';
    fallbackReasons[c] = (fallbackReasons[c] ?? 0) + 1;
  }
  const statuses: Record<string, number> = {};
  for (const s of ['analyzing', 'drafted', 'submitting', 'submitted', 'submission_failed', 'escalated', 'resolved'] as const) {
    statuses[s] = (await repo.listComplaintsByStatus([s])).length;
  }
  const attempts = submits.length;
  const automated = outcomes.submitted ?? 0;
  res.json({
    submission_attempts: attempts,
    automated_success_rate: attempts ? automated / attempts : null,
    captcha_block_rate: attempts ? (outcomes.blocked_by_captcha ?? 0) / attempts : null,
    outcomes,
    manual_fallback_reasons: fallbackReasons,
    complaints_by_status: statuses,
    pending_jurisdictions: (await repo.listJurisdictions('pending')).length,
  });
});

adminRouter.post('/monitor/run', requireAdmin, async (req, res) => {
  const r = await runMonitorSweep({ force: Boolean(req.body?.force) });
  res.json(r);
});

// ───────────── jobs (node-cron + external scheduler) ─────────────
export const jobsRouter = Router();
jobsRouter.use(express.json());
jobsRouter.post('/monitor-complaints', requireCron, async (req, res) => {
  const force = Boolean(req.body?.force);
  // Respond fast; the sweep continues in the background.
  void runMonitorSweep({ force }).catch((e) => console.error('[jobs/monitor]', safeError(e)));
  res.status(202).json({ started: true, force });
});
