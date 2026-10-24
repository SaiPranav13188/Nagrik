import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const common = { standardHeaders: true, legacyHeaders: false } as const;
const ip = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

/** Every request, per IP. Generous: the app polls complaint status while a pipeline runs. */
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 900,
  keyGenerator: ip,
  skip: (req) => req.path === '/health' || req.path.startsWith('/uploads/'),
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

/**
 * Admin and cron endpoints, per IP: only failed attempts count, so guessing the admin key is
 * capped at 20 tries per 15 minutes while a real admin is never locked out.
 */
export const failedAuthLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: ip,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  message: { error: 'Too many failed attempts. Try again in 15 minutes.' },
});

/** Actions that start agent runs or browser sessions (cost money / hit real portals), per user. */
export const agentActionLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 60,
  keyGenerator: (req) => (req as Request).userId ?? ip(req as Request),
  message: { error: "You've done that a lot in the last hour. Please try again later." },
});
