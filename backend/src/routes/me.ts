import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { repo } from '../db/index.js';
import { forgetUser, issueLocalToken, requireUser } from '../auth.js';
import { deleteAccount } from '../services/account.js';

export const authRouter = Router();

// Local (no-Supabase) mode only: exchange a device id for a signed token.
authRouter.post(
  '/local',
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }),
  async (req, res) => {
    if (repo.kind !== 'local') return res.status(404).json({ error: 'Use Supabase sign-in' });
    const body = z.object({ deviceId: z.string().min(8).max(128) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'deviceId required' });
    const { userId, token } = issueLocalToken(body.data.deviceId);
    const profile = (await repo.getProfile(userId)) ?? (await repo.upsertProfile({ id: userId }));
    res.json({ token, userId, profile });
  },
);

export const meRouter = Router();
meRouter.use(requireUser);

meRouter.get('/', async (req, res) => {
  const profile = (await repo.getProfile(req.userId)) ?? (await repo.upsertProfile({ id: req.userId, email: req.userEmail ?? null }));
  res.json({ profile });
});

const profileBody = z.object({
  full_name: z.string().trim().min(2).max(80).optional(),
  phone: z
    .string()
    .transform((v) => v.replace(/[\s()-]/g, '').replace(/^(\+91|0091|91(?=\d{10}$)|0(?=\d{10}$))/, ''))
    .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'))
    .optional(),
  email: z.string().email().nullable().optional(),
  preferred_language: z.enum(['en', 'te', 'hi']).optional(),
  auto_submit_default: z.boolean().optional(),
});

meRouter.put('/', async (req, res) => {
  const body = profileBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid profile' });
  const profile = await repo.upsertProfile({ id: req.userId, ...body.data });
  res.json({ profile });
});

meRouter.post('/push-token', async (req, res) => {
  const body = z.object({ token: z.string().max(200).nullable() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Invalid token' });
  await repo.upsertProfile({ id: req.userId, expo_push_token: body.data.token });
  res.json({ ok: true });
});

meRouter.get('/notifications', async (req, res) => {
  const items = await repo.listNotifications(req.userId);
  res.json({ notifications: items, unread: items.filter((n) => !n.read).length });
});

meRouter.post('/notifications/read', async (req, res) => {
  await repo.markNotificationsRead(req.userId);
  res.json({ ok: true });
});

// Deletes the account and everything stored about it. Explicit confirm so a stray call can't do it.
meRouter.delete('/', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5 }), async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Account deletion needs explicit confirmation (confirm: true).' });
  const r = await deleteAccount(req.userId);
  forgetUser(req.userId);
  res.json({ deleted: true, complaints: r.complaints, photos: r.photos });
});
