import { Queue, type Job } from 'bullmq';
import { config } from '../config.js';
import { fastConnection, redisReady, withTimeout } from '../redis/connection.js';

export const FILING_QUEUE = 'complaint-filing';

export interface FilingJobData {
  complaintId: string;
  /** True only when the citizen tapped Submit/Retry. Required before filing on a real portal. */
  citizenConfirmed: boolean;
}

/** One job id per complaint, so adding the same complaint twice never creates a second job. */
export const filingJobId = (complaintId: string) => `file-${complaintId}`; // BullMQ ids must not contain ":"

let queue: Queue<FilingJobData> | null = null;
export function filingQueue(): Queue<FilingJobData> {
  return (queue ??= new Queue<FilingJobData>(FILING_QUEUE, {
    connection: fastConnection()!,
    prefix: config.redisPrefix,
    defaultJobOptions: {
      attempts: config.filingMaxAttempts,
      backoff: { type: 'exponential', delay: config.filingBackoffMs }, // 10s, 20s, 40s, 80s
      removeOnComplete: { age: 3600, count: 1000 }, // keep 1 h of finished jobs
      removeOnFail: { age: 7 * 24 * 3600 }, // keep failures 7 days for debugging
    },
  }));
}

/** Every queue call goes through this: fail at once if Redis is down, and never wait more than 5 s. */
function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (!redisReady()) return Promise.reject(new Error('Redis is not connected'));
  return withTimeout(fn(), 5000, what);
}

const PENDING = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);

/**
 * Add (or update) the filing job for a complaint.
 * - Already running → leave it alone.
 * - Already waiting → keep it, unless this call carries something new: the citizen's
 *   confirmation, or a new review-window time for a job that has not been tried yet.
 * - Finished earlier (kept for debugging) → replace it, so a later Retry actually runs.
 * Two concurrent calls are still safe: BullMQ ignores a second add with the same job id.
 */
export function enqueueFiling(complaintId: string, opts: { citizenConfirmed?: boolean; delayMs?: number } = {}) {
  return guarded('enqueue filing', () => addOrUpdate(complaintId, opts));
}

async function addOrUpdate(complaintId: string, opts: { citizenConfirmed?: boolean; delayMs?: number }) {
  const q = filingQueue();
  const id = filingJobId(complaintId);
  const data: FilingJobData = { complaintId, citizenConfirmed: !!opts.citizenConfirmed };
  const existing = await q.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active') return existing;
    if (PENDING.has(state)) {
      const upgradesConfirmation = data.citizenConfirmed && !existing.data.citizenConfirmed;
      const reschedules = !data.citizenConfirmed && !existing.data.citizenConfirmed && existing.attemptsMade === 0 && opts.delayMs !== undefined;
      if (!upgradesConfirmation && !reschedules) return existing;
    }
    try {
      await existing.remove();
    } catch {
      return existing; // picked up by the worker a moment ago (locked): it is running now
    }
  }
  return q.add('file-complaint', data, { jobId: id, delay: Math.max(0, opts.delayMs ?? 0) });
}

/** Remove a complaint's job if it hasn't started (citizen tapped Hold, edited the draft, deleted their account). */
export function cancelFiling(complaintId: string) {
  return guarded('cancel filing', () => removeIfNotStarted(complaintId));
}

async function removeIfNotStarted(complaintId: string) {
  const job = await filingQueue().getJob(filingJobId(complaintId));
  if (!job) return false;
  const state = await job.getState();
  if (state === 'active') return false;
  try {
    await job.remove();
    return true;
  } catch {
    return false;
  }
}

export function getFilingJob(complaintId: string): Promise<Job<FilingJobData> | undefined> {
  return guarded('get filing job', () => filingQueue().getJob(filingJobId(complaintId)));
}

/** What the app shows while filing: queued, running, or waiting to retry (and when). */
export async function filingStatus(complaintId: string) {
  const job = await getFilingJob(complaintId);
  if (!job) return null;
  const state = await withTimeout(job.getState(), 5000, 'job state');
  // A scheduled (review-window) job knows when it runs; a retry's exact time lives only in Redis.
  const nextAttemptAt = state === 'delayed' && job.attemptsMade === 0 && job.delay ? new Date(job.timestamp + job.delay).toISOString() : null;
  return {
    state: state === 'delayed' && job.attemptsMade > 0 ? 'waiting_to_retry' : state,
    attempts: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    nextAttemptAt,
  };
}

export function filingCounts() {
  return guarded('job counts', () => filingQueue().getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed'));
}

export async function closeFilingQueue() {
  await queue?.close().catch(() => {});
  queue = null;
}
