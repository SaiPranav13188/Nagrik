import cron from 'node-cron';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { runAgent } from '../ai/runtime.js';
import { coordinatorAgent, runSubmission, submissionHooks } from '../agents/coordinator.js';
import { monitorSupervisorAgent } from '../agents/monitoring.js';
import { safeError } from './log.js';
import { redisEnabled } from '../redis/connection.js';
import { cancelFiling, enqueueFiling, filingCounts, getFilingJob } from '../queues/filingQueue.js';

/** Minimal in-process task queue with a concurrency cap. */
class TaskQueue {
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(private concurrency: number) {}
  get depth() {
    return this.running + this.waiting.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

// Pipelines are mostly LLM calls → a few in parallel. Submissions drive a real browser → one at a time.
const pipelineQueue = new TaskQueue(4);
const submissionQueue = new TaskQueue(1);
const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

export function queueStats() {
  return { pipelines: pipelineQueue.depth, submissions: submissionQueue.depth, scheduledSubmissions: timers.size };
}

export function scheduleSubmission(complaintId: string, atMs: number) {
  const delay = Math.max(0, atMs - Date.now());
  if (redisEnabled) {
    // A delayed BullMQ job replaces the in-memory timer: it survives restarts of the API process.
    enqueueFiling(complaintId, { delayMs: delay }).catch((e) => {
      console.error('[queue] could not schedule filing, using an in-memory timer:', safeError(e));
      scheduleInMemory(complaintId, delay);
    });
    return;
  }
  scheduleInMemory(complaintId, delay);
}
submissionHooks.schedule = scheduleSubmission;

function scheduleInMemory(complaintId: string, delay: number) {
  clearTimeout(timers.get(complaintId));
  timers.set(
    complaintId,
    setTimeout(() => {
      timers.delete(complaintId);
      void runInMemory(complaintId, false);
    }, delay),
  );
}

/**
 * citizenConfirmed: the citizen tapped Submit/Retry. Timers and boot recovery never set it.
 * With Redis the job goes to the filing queue (retries, one job per complaint); if Redis can't
 * take it right now, it runs in-process as before so the citizen is never left waiting.
 */
export async function enqueueSubmission(complaintId: string, citizenConfirmed = false) {
  if (redisEnabled) {
    try {
      await enqueueFiling(complaintId, { citizenConfirmed });
      return;
    } catch (e) {
      console.error('[queue] Redis unavailable, filing in-process instead:', safeError(e));
    }
  }
  await runInMemory(complaintId, citizenConfirmed);
}

function runInMemory(complaintId: string, citizenConfirmed: boolean) {
  if (inFlight.has(complaintId)) return Promise.resolve();
  inFlight.add(complaintId);
  return submissionQueue
    .run(() => runSubmission(complaintId, citizenConfirmed))
    .then(() => {})
    .finally(() => inFlight.delete(complaintId));
}

export async function holdSubmission(complaintId: string) {
  clearTimeout(timers.get(complaintId));
  timers.delete(complaintId);
  if (redisEnabled) await cancelFiling(complaintId).catch((e) => console.error('[queue] could not cancel filing:', safeError(e)));
  await repo.updateComplaint(complaintId, { submit_after: null });
}

/** Queue numbers for /health. */
export async function filingQueueStats() {
  if (!redisEnabled) return { backend: 'memory' as const };
  try {
    return { backend: 'redis' as const, ...(await filingCounts()) };
  } catch (e) {
    return { backend: 'redis' as const, error: (e as Error).message };
  }
}

export function startPipeline(complaintId: string, userId: string) {
  return pipelineQueue.run(async () => {
    try {
      await runAgent(coordinatorAgent, { complaintId }, { complaintId, userId });
    } catch (e) {
      console.error('[pipeline]', complaintId, safeError(e));
      const c = await repo.getComplaint(complaintId);
      if (c && c.status === 'analyzing') {
        await repo.updateComplaint(complaintId, {
          status: 'submission_failed',
          failure_reason: '[portal_error] Our assistant hit a problem while preparing this complaint. Tap Retry.',
        });
      }
    }
  });
}

let sweeping: Promise<unknown> | null = null;
export function runMonitorSweep(opts: { force?: boolean; complaintId?: string } = {}) {
  if (sweeping && !opts.complaintId) return sweeping;
  const p = runAgent(monitorSupervisorAgent, { force: !!opts.force, onlyComplaintId: opts.complaintId }).finally(() => {
    if (!opts.complaintId) sweeping = null;
  });
  if (!opts.complaintId) sweeping = p;
  return p;
}

/**
 * Re-arm work that was in progress when the process restarted. Supabase is the source of truth:
 * with Redis, a job that is still in the queue is left to BullMQ (it re-runs stalled jobs itself);
 * a job Redis lost (the free Key Value keeps nothing across its own restarts) is added again.
 */
export async function recoverOnBoot() {
  const drafted = await repo.listComplaintsByStatus(['drafted', 'submitting', 'analyzing']);
  for (const c of drafted) {
    if (c.status === 'analyzing') {
      void startPipeline(c.id, c.user_id);
      continue;
    }
    if (redisEnabled && (await queuedJobExists(c.id))) continue;
    if (c.status === 'submitting') {
      await repo.updateComplaint(c.id, { status: 'drafted', submit_after: new Date().toISOString() });
      scheduleSubmission(c.id, Date.now() + 2000);
    } else if (c.status === 'drafted' && c.submit_after) {
      scheduleSubmission(c.id, new Date(c.submit_after).getTime());
    }
  }
}

async function queuedJobExists(complaintId: string) {
  try {
    const job = await getFilingJob(complaintId);
    if (!job) return false;
    return !['completed', 'failed', 'unknown'].includes(await job.getState());
  } catch {
    return false;
  }
}

export function startCron() {
  if (!config.enableCron) return;
  cron.schedule(config.monitorCron, () => {
    runMonitorSweep().catch((e) => console.error('[cron monitor]', safeError(e)));
  }, { timezone: 'Asia/Kolkata' });
  console.log(`[cron] monitoring sweep scheduled: "${config.monitorCron}" (Asia/Kolkata)`);
}
