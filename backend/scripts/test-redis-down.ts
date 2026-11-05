/**
 * Run by test-redis.ts with REDIS_URL pointing at a port where nothing listens: everything that
 * uses Redis must fall back quickly instead of failing or hanging.
 */
import { TEST_REDIS_URL } from './test-env.js';
process.env.REDIS_URL = TEST_REDIS_URL; // the dead address test-redis.ts passed in
import express from 'express';

const { getOrSet } = await import('../src/redis/cache.js');
const { redisRateLimit } = await import('../src/redis/rateLimit.js');
const { enqueueSubmission, filingQueueStats, holdSubmission } = await import('../src/services/scheduler.js');
const { submitStartedEarlier } = await import('../src/services/submitGuard.js');

const t0 = Date.now();
const timed = async <T>(name: string, p: Promise<T>) => {
  const s = Date.now();
  const v = await p;
  console.log(`${name}: ${Date.now() - s} ms`);
  return v;
};

const v = await timed('cache read-through', getOrSet('down', 'x', 60, async () => 'from-loader'));
if (v !== 'from-loader') throw new Error('cache did not fall back to the loader');

const app = express();
app.get('/', redisRateLimit({ name: 'down', windowSec: 60, max: 1, message: 'x' }), (_q, r) => r.send('ok'));
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
for (let i = 0; i < 3; i++) {
  const r = await timed(`rate-limited request ${i + 1}`, fetch(`http://127.0.0.1:${port}/`));
  if (r.status !== 200) throw new Error(`rate limiter did not fail open (${r.status})`);
}
server.close();

// No such complaint: the in-process fallback runs and finds nothing to do — it must not hang.
await timed('submit (falls back to in-process)', enqueueSubmission('00000000-0000-0000-0000-000000000000', true));
await timed('hold', holdSubmission('00000000-0000-0000-0000-000000000000').catch(() => {}));
const stats = await timed('health queue stats', filingQueueStats());
if (!('error' in stats)) throw new Error('queue stats should report the Redis error');
if (await submitStartedEarlier('x')) throw new Error('guard should read as "no marker" when Redis is down');

const total = Date.now() - t0;
console.log(`total: ${total} ms`);
if (total > 20_000) throw new Error('fallbacks were too slow');
process.exit(0);
