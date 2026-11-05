/**
 * Redis tests: the BullMQ filing queue, retries, idempotency, the double-filing guard, the cache
 * and the rate limiter — against a REAL Redis (CI runs a redis:7 service).
 *
 *   REDIS_URL=redis://localhost:6379 npm run test:redis
 *
 * Uses the real app, the real Submission Agent (offline planner) and a real browser against local
 * mock portals, like test-failures.ts. Everything it writes lives under a throwaway key prefix.
 */
import { TEST_PORT, TEST_REDIS_URL } from './test-env.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';

process.env.REDIS_URL = TEST_REDIS_URL;
if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is not set. Run this against a real Redis, e.g. REDIS_URL=redis://localhost:6379 npm run test:redis');
  process.exit(1);
}
const PREFIX = `nagrik-test-${process.pid}`;
Object.assign(process.env, {
  REDIS_PREFIX: PREFIX,
  FILING_MAX_ATTEMPTS: '3',
  FILING_BACKOFF_MS: '300', // 0.3 s, 0.6 s instead of 10 s, 20 s
  FILING_WORKER: 'off', // this test starts the worker itself
});

const { app } = await import('../src/app.js');
const { repo } = await import('../src/db/index.js');
const { buildSeedJurisdictions } = await import('../src/db/seed.js');
const { closeBrowser } = await import('../src/automation/portal.js');
const { sandboxState } = await import('../src/sandboxPortal/router.js');
const { enqueueSubmission, holdSubmission, scheduleSubmission } = await import('../src/services/scheduler.js');
const { enqueueFiling, filingQueue, filingJobId, getFilingJob, closeFilingQueue, filingStatus } = await import('../src/queues/filingQueue.js');
const { startFilingWorker, filingProcessor } = await import('../src/workers/filingWorker.js');
const { markSubmitStarted, submitStartedEarlier } = await import('../src/services/submitGuard.js');
const { getOrSet, clearCache, cacheStats } = await import('../src/redis/cache.js');
const { redisRateLimit } = await import('../src/redis/rateLimit.js');
const { closeRedis, fastConnection, waitForRedis, key } = await import('../src/redis/connection.js');
type Complaint = import('../src/db/types.js').Complaint;
type Jurisdiction = import('../src/db/types.js').Jurisdiction;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`, !ok && detail !== undefined ? JSON.stringify(detail).slice(0, 400) : '');
  if (!ok) failures++;
};
const section = (t: string) => console.log(`\n── ${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean | Promise<boolean>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let v = await fn();
  while (!(await ok(v)) && Date.now() < end) {
    await sleep(200);
    v = await fn();
  }
  return v;
}

if (!(await waitForRedis(15_000))) {
  console.error('Could not connect to Redis at REDIS_URL.');
  process.exit(1);
}

// ───────────── servers: the real app + a flaky portal ─────────────
const server = app.listen(TEST_PORT);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const formHtml = await (await fetch(`${BASE}/sandbox-portal`)).text();
let flakyFailuresLeft = 0;
let flakyHits = 0;
const portals = express();
// Drops the connection while flakyFailuresLeft > 0 (the browser sees the portal as unreachable),
// then serves the real sandbox form, which files on the app's sandbox portal.
portals.get('/flaky', (req, res) => {
  flakyHits++;
  if (flakyFailuresLeft > 0) {
    flakyFailuresLeft--;
    req.socket.destroy();
    return;
  }
  res.type('html').send(formHtml.replace('action="/sandbox-portal/submit"', `action="${BASE}/sandbox-portal/submit"`));
});
const PORTALS_PORT = TEST_PORT + 3;
const portalServer = portals.listen(PORTALS_PORT);
const P = `http://127.0.0.1:${PORTALS_PORT}`;
const DEAD = `http://127.0.0.1:${TEST_PORT + 4}/form`; // nothing listens here

// ───────────── fixtures ─────────────
const sandboxTemplate = buildSeedJurisdictions().find((j) => j.is_sandbox && j.issue_type === 'pothole')!;
function portal(over: Partial<Jurisdiction>) {
  const { id: _id, created_at: _c, ...t } = sandboxTemplate;
  return repo.insertJurisdiction({ ...t, ...over });
}
const userId = randomUUID();
await repo.upsertProfile({ id: userId, full_name: 'Test Citizen', phone: '9876543210' });
function complaint(j: Jurisdiction | null, over: Partial<Complaint> = {}) {
  return repo.createComplaint({
    user_id: userId,
    photo_url: null,
    issue_type: 'pothole',
    description: 'A deep pothole on the main road near the bus stand.',
    severity: 'medium',
    address: 'Main Road, near RTC Bus Stand, Wanaparthy, Telangana 509103',
    city: 'Wanaparthy',
    state: 'Telangana',
    status: 'drafted',
    auto_submit: true,
    jurisdiction_portal_id: j?.id ?? null,
    jurisdiction_department: j?.department_name ?? null,
    draft_subject: 'Deep pothole near RTC bus stand',
    draft_text: 'To\nThe Engineering Section\n\nA deep pothole on the main road near the RTC bus stand is causing accidents. Kindly repair it.\n\nTest Citizen\nMobile: 9876543210',
    ...over,
  });
}
const get = async (id: string) => (await repo.getComplaint(id))!;
const category = (c: Complaint) => c.failure_reason?.match(/^\[(\w+)\]/)?.[1] ?? null;
const grievances = () => sandboxState.get().grievances.length;
const notificationsFor = async (complaintId: string) => (await repo.listNotifications(userId)).filter((n) => n.complaint_id === complaintId);
const jobState = async (complaintId: string) => (await (await getFilingJob(complaintId))?.getState()) ?? 'none';

async function main() {
  const sandboxPothole = (await repo.findJurisdictions({ city: 'Wanaparthy', state: 'Telangana', issueType: 'pothole', sandbox: true, reviewStatuses: ['approved'] }))[0];

  // ───────────── idempotency (before any worker runs) ─────────────
  section('Idempotency: one job per complaint');
  const idem = await complaint(sandboxPothole);
  await Promise.all([enqueueFiling(idem.id, { citizenConfirmed: true }), enqueueFiling(idem.id, { citizenConfirmed: true }), enqueueSubmission(idem.id, true)]);
  const waiting = await filingQueue().getJobs(['waiting', 'delayed', 'active', 'prioritized']);
  check('three concurrent submits of the same complaint → exactly 1 job', waiting.filter((j) => j.data.complaintId === idem.id).length === 1, waiting.map((j) => j.id));
  check('job id is "file-<complaint id>" (no ":")', waiting.some((j) => j.id === filingJobId(idem.id)));
  await holdSubmission(idem.id);
  check('Hold removes a job that has not started', (await jobState(idem.id)) === 'none');

  section('Scheduling (review window) and the citizen confirming');
  const sched = await complaint(sandboxPothole);
  scheduleSubmission(sched.id, Date.now() + 60_000);
  await until(() => jobState(sched.id), (s) => s === 'delayed', 5000);
  let job = await getFilingJob(sched.id);
  check('auto-submit schedules a delayed job (survives an API restart)', (await job?.getState()) === 'delayed' && job?.data.citizenConfirmed === false, await job?.getState());
  const fs1 = await filingStatus(sched.id);
  check('status shows when the scheduled filing runs', !!fs1?.nextAttemptAt && fs1.state === 'delayed', fs1);
  await enqueueSubmission(sched.id, true);
  job = await getFilingJob(sched.id);
  check('tapping Submit replaces the delayed job: runs now, with the citizen’s confirmation', ['waiting', 'prioritized'].includes(await job!.getState()) && job!.data.citizenConfirmed === true, { state: await job!.getState(), data: job!.data });
  await holdSubmission(sched.id);

  // ───────────── the worker ─────────────
  const worker = startFilingWorker();
  await worker.waitUntilReady();

  section('Happy path through the queue');
  const before = grievances();
  const ok = await complaint(sandboxPothole);
  await enqueueSubmission(ok.id, true);
  let c = await until(() => get(ok.id), (x) => x.status === 'submitted' || x.status === 'submission_failed');
  check('queued complaint is filed on the sandbox portal', c.status === 'submitted' && !!c.tracking_id && grievances() === before + 1, { status: c.status, reason: c.failure_reason });
  check('marker is cleared after a recorded filing', !(await submitStartedEarlier(ok.id)));

  section('Already filed → nothing happens');
  const g1 = grievances();
  await enqueueFiling(ok.id, { citizenConfirmed: true }); // completed job is replaced, runs again
  job = await until(() => getFilingJob(ok.id), (j) => !!j && j.returnvalue?.outcome === 'already_submitted', 20_000);
  check('worker sees "submitted" and returns already_submitted, no second filing', job?.returnvalue?.outcome === 'already_submitted' && grievances() === g1, job?.returnvalue);

  section('Temporary failure: retried with backoff, then succeeds');
  const g2 = grievances();
  flakyFailuresLeft = 2;
  flakyHits = 0;
  const flaky = await complaint(await portal({ portal_url: `${P}/flaky` }));
  await enqueueSubmission(flaky.id, true);
  // Mid-way the citizen sees it is still being worked on, not a failure.
  const mid = await until(() => get(flaky.id), (x) => x.status === 'submitting' && x.failure_reason?.startsWith('[navigation_failed]') === true, 30_000);
  check('between tries the complaint stays "submitting" (no failure shown yet)', mid.status === 'submitting', { status: mid.status, reason: mid.failure_reason });
  c = await until(() => get(flaky.id), (x) => x.status === 'submitted' || x.status === 'submission_failed', 90_000);
  job = await getFilingJob(flaky.id);
  check('portal down twice, then up → filed on the 3rd attempt', c.status === 'submitted' && job?.attemptsMade === 2 && grievances() === g2 + 1, { status: c.status, attemptsMade: job?.attemptsMade, hits: flakyHits, reason: c.failure_reason });
  const fn = await notificationsFor(flaky.id);
  check('citizen gets ONE message ("filed"), none for the retried attempts', fn.length === 1 && /filed/i.test(fn[0].title), fn.map((n) => n.title));

  section('Retries exhausted → handed back to the citizen once');
  const dead = await complaint(await portal({ portal_url: DEAD }));
  await enqueueSubmission(dead.id, true);
  c = await until(() => get(dead.id), (x) => x.status === 'submission_failed', 90_000);
  job = await until(() => getFilingJob(dead.id), async (j) => !!j && (await j.getState()) !== 'active', 10_000);
  check('3 tries, then submission_failed [navigation_failed]', c.status === 'submission_failed' && category(c) === 'navigation_failed', { reason: c.failure_reason, attempts: job?.attemptsMade });
  check('…and exactly one message to the citizen', (await notificationsFor(dead.id)).length === 1, (await notificationsFor(dead.id)).map((n) => n.title));

  section('Permanent failures are NOT retried');
  const cap = await complaint(await portal({ portal_url: `${P}/flaky`, requires_captcha: true }));
  flakyHits = 0;
  await enqueueSubmission(cap.id, true);
  c = await until(() => get(cap.id), (x) => x.status === 'submission_failed', 30_000);
  job = await getFilingJob(cap.id);
  await sleep(1500); // would be enough for a retry with 0.3 s backoff
  check('CAPTCHA portal → handed back after 1 attempt, never opened', category(c) === 'otp_gate' && (job?.attemptsStarted ?? 0) <= 1 && flakyHits === 0, { reason: c.failure_reason, attemptsStarted: job?.attemptsStarted });
  const errPortal = await complaint(await portal({ portal_url: `${P}/flaky`, review_status: 'pending' }));
  await enqueueSubmission(errPortal.id, true);
  c = await until(() => get(errPortal.id), (x) => x.status === 'submission_failed', 30_000);
  check('unverified portal → handed back, not retried', category(c) === 'unverified_portal', c.failure_reason);

  section('Double-filing guard (process died after pressing Submit)');
  const g3 = grievances();
  const crash = await complaint(sandboxPothole, { status: 'submitting' }); // as left by a crashed attempt
  await markSubmitStarted(crash.id); // the marker that crashed attempt left behind
  await enqueueFiling(crash.id, { citizenConfirmed: true });
  c = await until(() => get(crash.id), (x) => x.status === 'submission_failed', 30_000);
  check('next attempt does NOT file again: asks the citizen to check the portal', grievances() === g3 && /may already be filed/.test(c.failure_reason ?? ''), c.failure_reason);
  job = await until(() => getFilingJob(crash.id), async (j) => !!j && (await j.getState()) === 'failed', 10_000);
  check('job fails immediately (UnrecoverableError), ran once, no retries', (await job?.getState()) === 'failed' && job?.attemptsStarted === 1, { state: await job?.getState(), attemptsStarted: job?.attemptsStarted });
  check('marker is cleared so the citizen’s own Retry can file', !(await submitStartedEarlier(crash.id)));

  section('A crash after the form was sent is never retried into a second filing');
  // Fake runner: attempt 1 "files" then crashes before recording it (marker left behind).
  let calls = 0;
  const g4 = grievances();
  const crash2 = await complaint(sandboxPothole);
  const proc = filingProcessor(async (id, confirmed, opts) => {
    calls++;
    if (calls === 1) {
      await markSubmitStarted(id);
      return 'retry'; // as runSubmission returns after an exception with retries left
    }
    const { runSubmission } = await import('../src/agents/coordinator.js');
    return runSubmission(id, confirmed, opts);
  });
  const fakeJob = (attemptsMade: number) => ({ data: { complaintId: crash2.id, citizenConfirmed: true }, attemptsMade, opts: { attempts: 3 } }) as never;
  let threw: unknown = null;
  try {
    await proc(fakeJob(0));
  } catch (e) {
    threw = e;
  }
  check('attempt 1 asks for a retry', threw instanceof Error && /retry/i.test((threw as Error).message));
  threw = null;
  try {
    await proc(fakeJob(1));
  } catch (e) {
    threw = e;
  }
  c = await get(crash2.id);
  check('attempt 2 refuses to file again (verify first)', grievances() === g4 && c.status === 'submission_failed' && /may already be filed/.test(c.failure_reason ?? '') && (threw as Error)?.name === 'UnrecoverableError', { reason: c.failure_reason, threw: String(threw) });

  await worker.close();

  // ───────────── cache ─────────────
  section('Cache');
  let loads = 0;
  const loader = async () => {
    loads++;
    return { office: 'Wanaparthy Municipality' };
  };
  const a1 = await getOrSet('test', 'k1', 60, loader);
  const a2 = await getOrSet('test', 'k1', 60, loader);
  check('second read comes from Redis (loader ran once)', loads === 1 && a2?.office === a1?.office && cacheStats.test.hits === 1, { loads, stats: cacheStats.test });
  const ttl = await fastConnection()!.ttl(key('cache', 'test', 'k1'));
  check('cached keys always have a TTL', ttl > 0 && ttl <= 60, ttl);
  let nullLoads = 0;
  await getOrSet('test', 'uncertain', 60, async () => (nullLoads++, null));
  await getOrSet('test', 'uncertain', 60, async () => (nullLoads++, null));
  check('null results (uncertain / failed) are never cached', nullLoads === 2);
  await clearCache('test');
  await getOrSet('test', 'k1', 60, loader);
  check('clearCache drops entries (e.g. after an admin review)', loads === 2);

  const { approvedOffices } = await import('../src/agents/jurisdiction.js');
  const q = { city: 'Wanaparthy', state: 'Telangana', issueType: 'pothole' as const, sandbox: true };
  const o1 = await approvedOffices(q);
  const hitsBefore = cacheStats.office?.hits ?? 0;
  const o2 = await approvedOffices(q);
  check('approved office lookup is cached', o1.length > 0 && o2[0]?.id === o1[0]?.id && (cacheStats.office?.hits ?? 0) === hitsBefore + 1, cacheStats.office);
  const none = await approvedOffices({ ...q, city: 'Nowhere' });
  const noneAgain = await approvedOffices({ ...q, city: 'Nowhere' });
  check('"no office found" is not cached (an approval shows up at once)', none.length === 0 && noneAgain.length === 0 && (await fastConnection()!.exists(key('cache', 'office', 'sandbox|pothole|telangana|nowhere'))) === 0);

  // ───────────── rate limit ─────────────
  section('Rate limit (Redis)');
  const rl = express();
  rl.use((req, _res, next) => ((req.userId = 'user-a'), next()));
  rl.post('/submit', redisRateLimit({ name: 'test-submit', windowSec: 60, max: 5, message: 'slow down' }), (_req, res) => res.json({ ok: true }));
  const rlServer = rl.listen(TEST_PORT + 5);
  const codes: number[] = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`http://127.0.0.1:${TEST_PORT + 5}/submit`, { method: 'POST' });
    codes.push(r.status);
    if (r.status === 429) retryAfter = r.headers.get('retry-after');
  }
  check('5 requests a minute are allowed, the 6th gets 429 with Retry-After', codes.slice(0, 5).every((s) => s === 200) && codes[5] === 429 && Number(retryAfter) > 0, { codes, retryAfter });
  rlServer.close();

  section('Redis down → the app keeps working');
  const down = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/test-redis-down.ts'], {
    env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  check('cache, rate limit and filing fall back without errors or hangs', down.status === 0, (down.stdout + down.stderr).slice(-600));
  console.log(down.stdout.trim().split('\n').map((l) => `   ${l}`).join('\n'));
}

try {
  await main();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await filingQueue().obliterate({ force: true }).catch(() => {});
  const r = fastConnection();
  if (r) {
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length) await r.del(...keys);
    } while (cursor !== '0');
  }
  await closeFilingQueue();
  await closeRedis();
  await closeBrowser();
  server.close();
  portalServer.close();
}
console.log(failures ? `\n${failures} Redis check(s) failed` : '\nAll Redis checks passed');
process.exit(failures ? 1 : 0);
