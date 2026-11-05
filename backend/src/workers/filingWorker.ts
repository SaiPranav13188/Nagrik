import { pathToFileURL } from 'node:url';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { runSubmission, type SubmissionOutcome } from '../agents/coordinator.js';
import { closeRedis, workerConnection } from '../redis/connection.js';
import { FILING_QUEUE, type FilingJobData } from '../queues/filingQueue.js';
import { safeError } from '../services/log.js';

/** Thrown for temporary problems (portal unreachable): BullMQ retries with exponential backoff. */
export class RetryableFilingError extends Error {}

export type FilingRunner = typeof runSubmission;

/** The job handler, kept separate so tests can drive it with a fake runner. */
export function filingProcessor(run: FilingRunner = runSubmission) {
  return async (job: Job<FilingJobData>): Promise<{ outcome: SubmissionOutcome }> => {
    const { complaintId, citizenConfirmed } = job.data;
    const attempt = job.attemptsMade + 1;
    const finalAttempt = attempt >= (job.opts.attempts ?? 1);
    const outcome = await run(complaintId, citizenConfirmed, { finalAttempt, fromQueue: true });
    console.log(`[filing] complaint=${complaintId} attempt=${attempt}/${job.opts.attempts ?? 1} outcome=${outcome}`);
    if (outcome === 'retry') throw new RetryableFilingError('Portal could not be reached; will retry');
    // Retrying can never help these: fail the job now so it shows up in the dashboard.
    if (outcome === 'verify_first') throw new UnrecoverableError('Previous attempt stopped after sending the form; citizen asked to verify');
    return { outcome };
  };
}

/**
 * Start the filing worker. On Render's free plan it runs inside the API process (FILING_WORKER=inline);
 * with docker-compose or a paid worker service it runs alone via `npm run worker`.
 */
export function startFilingWorker(run: FilingRunner = runSubmission) {
  const worker = new Worker<FilingJobData>(FILING_QUEUE, filingProcessor(run), {
    connection: workerConnection(),
    prefix: config.redisPrefix,
    // Each job is a whole browser. Keep this low.
    concurrency: config.filingConcurrency,
  });

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const exhausted = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) return;
    // runSubmission records the outcome itself on the final attempt; this is only a safety net so
    // a complaint can never stay "submitting" forever.
    const c = await repo.getComplaint(job.data.complaintId).catch(() => null);
    if (c?.status === 'submitting') {
      await repo
        .updateComplaint(c.id, { status: 'submission_failed', failure_reason: `[portal_error] Automatic filing did not complete after ${job.attemptsMade} tries. Your complaint text is ready to submit yourself.` })
        .catch((e) => console.error('[filing] could not mark failed:', safeError(e)));
    }
    console.error(`[filing] complaint ${job.data.complaintId} needs attention: ${err.message}`);
  });
  worker.on('error', (err) => console.error('[filing] worker error:', err.message));

  console.log(`[filing] worker started (concurrency ${config.filingConcurrency}, ${config.filingMaxAttempts} attempts)`);
  return worker;
}

// `npm run worker`: run the worker as its own process (docker-compose, or a paid Render worker).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { initRepo } = await import('../db/index.js');
  const { closeBrowser } = await import('../automation/portal.js');
  const { shutdownTracing } = await import('../ai/tracing.js');
  if (!config.redisUrl) {
    console.error('[filing] REDIS_URL is not set; the worker needs Redis.');
    process.exit(1);
  }
  await initRepo();
  const worker = startFilingWorker();
  // Shut down cleanly so a job is not killed halfway on deploy.
  const shutdown = async () => {
    await worker.close();
    await closeBrowser();
    await shutdownTracing();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
