import type { NextFunction, Request, Response } from 'express';
import { fastConnection, key } from './connection.js';

/**
 * Fixed-window, per-user rate limit stored in Redis, so it is shared by every server process and
 * survives restarts. Sits on top of the hourly in-memory limits in rateLimits.ts.
 * Fails open: if Redis is off or down the request is allowed (the in-memory limits still apply).
 */
export function redisRateLimit(opts: { name: string; windowSec: number; max: number; message: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const redis = fastConnection();
    if (!redis) return next();
    try {
      // Keyed by limiter name + user (not by path), so the limit is per user across all complaints.
      const who = req.userId ?? `ip-${req.ip ?? 'unknown'}`;
      const k = key('rl', opts.name, who);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, opts.windowSec);
      if (n > opts.max) {
        let ttl = await redis.ttl(k);
        if (ttl < 0) {
          // The expiry was lost (e.g. a crash between INCR and EXPIRE): set it so the key can't stick.
          await redis.expire(k, opts.windowSec);
          ttl = opts.windowSec;
        }
        res.set('Retry-After', String(Math.max(ttl, 1)));
        return res.status(429).json({ error: opts.message });
      }
    } catch (e) {
      console.warn(`[ratelimit] ${opts.name}: redis error, allowing request:`, (e as Error).message);
    }
    next();
  };
}

/** Starting a filing or a retry: 5 a minute per user. */
export const submitPerMinute = redisRateLimit({
  name: 'submit',
  windowSec: 60,
  max: 5,
  message: 'Please wait a minute before submitting again.',
});

/** Anything that calls Gemini (photo analysis, voice, drafting, jurisdiction): 20 a minute per user. */
export const aiPerMinute = redisRateLimit({
  name: 'ai',
  windowSec: 60,
  max: 20,
  message: 'Too many requests in a minute. Please wait a moment and try again.',
});
