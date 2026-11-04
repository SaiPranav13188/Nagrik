import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { LangfuseOtelSpanAttributes, startObservation } from '@langfuse/tracing';
import { config } from '../config.js';
import { tracingEnabled } from '../ai/tracing.js';

/**
 * Crash and error reports from the phone app (free replacement for a paid crash service).
 * Each report goes to the Render logs and, when tracing is on, to Langfuse as an ERROR event
 * named "app-crash", so crashes sit next to the agent traces.
 *
 * No sign-in needed (the app can crash before sign-in), so it is rate-limited per IP and every
 * field is scrubbed of anything personal before it is stored.
 */
export const clientErrorsRouter = Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { error: 'Too many reports.' },
});

/** Strip emails, phone numbers, long digit runs, tokens and URL query strings. */
export function scrub(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\?[^\s)]*/g, '?[query]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .slice(0, max);
}

clientErrorsRouter.post('/', limiter, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const report = {
    message: scrub(b.message, 300) || 'Unknown error',
    stack: scrub(b.stack, 2000),
    screen: scrub(b.screen, 100),
    fatal: b.fatal === true,
    source: scrub(b.source, 30),
    appVersion: scrub(b.appVersion, 20),
    platform: scrub(b.platform, 20),
    osVersion: scrub(b.osVersion, 20),
  };
  console.error(`[app-crash] ${report.fatal ? 'FATAL ' : ''}${report.platform} ${report.osVersion} v${report.appVersion} ${report.screen}: ${report.message}`);
  if (tracingEnabled) {
    const span = startObservation('app-crash', { input: report, level: 'ERROR', statusMessage: report.message });
    span.otelSpan.setAttributes({
      [LangfuseOtelSpanAttributes.TRACE_NAME]: 'app-crash',
      [LangfuseOtelSpanAttributes.TRACE_TAGS]: ['app-crash', config.nodeEnv, report.fatal ? 'fatal' : 'non-fatal'],
    });
    span.setTraceIO({ input: report });
    span.end();
  }
  res.status(204).end();
});
