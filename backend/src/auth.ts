import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { repo } from './db/index.js';
import { SupabaseRepo } from './db/supabaseRepo.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      userEmail?: string | null;
    }
  }
}

// ── Local mode: HMAC-signed device tokens (no accounts needed for development) ──
function sign(userId: string) {
  return createHmac('sha256', config.localAuthSecret).update(userId).digest('base64url');
}

export function issueLocalToken(deviceId: string) {
  const h = createHash('sha256').update(`nagrik:${deviceId}`).digest('hex');
  const userId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { userId, token: `local.${userId}.${sign(userId)}` };
}

function verifyLocalToken(token: string): string | null {
  const [prefix, userId, sig] = token.split('.');
  if (prefix !== 'local' || !userId || !sig) return null;
  const expected = Buffer.from(sign(userId));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got) ? userId : null;
}

// ── Supabase mode: verify the user's access token with Supabase Auth ──
const cache = new Map<string, { userId: string; email: string | null; exp: number }>();

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Sign in required' });

  if (repo instanceof SupabaseRepo) {
    const hit = cache.get(token);
    if (hit && hit.exp > Date.now()) {
      req.userId = hit.userId;
      req.userEmail = hit.email;
      return next();
    }
    const { data, error } = await repo.client.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    cache.set(token, { userId: data.user.id, email: data.user.email ?? null, exp: Date.now() + 60_000 });
    if (cache.size > 5000) cache.clear();
    req.userId = data.user.id;
    req.userEmail = data.user.email ?? null;
    return next();
  }

  const userId = verifyLocalToken(token);
  if (!userId) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  req.userId = userId;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== config.adminApiKey) return res.status(401).json({ error: 'Admin key required' });
  next();
}

export function requireCron(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-cron-secret'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (key !== config.cronSecret) return res.status(401).json({ error: 'Invalid cron secret' });
  next();
}
