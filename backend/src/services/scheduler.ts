import cron from 'node-cron';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { runAgent } from '../ai/runtime.js';
import { coordinatorAgent, runSubmission, submissionHooks } from '../agents/coordinator.js';
import { monitorSupervisorAgent } from '../agents/monitoring.js';

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
  clearTimeout(timers.get(complaintId));
  const delay = Math.max(0, atMs - Date.now());
  timers.set(
    complaintId,
    setTimeout(() => {
      timers.delete(complaintId);
      void enqueueSubmission(complaintId);
    }, delay),
  );
}
submissionHooks.schedule = scheduleSubmission;

export function enqueueSubmission(complaintId: string) {
  if (inFlight.has(complaintId)) return Promise.resolve();
  inFlight.add(complaintId);
  return submissionQueue.run(() => runSubmission(complaintId)).finally(() => inFlight.delete(complaintId));
}

export async function holdSubmission(complaintId: string) {
  clearTimeout(timers.get(complaintId));
  timers.delete(complaintId);
  await repo.updateComplaint(complaintId, { submit_after: null });
}

export function startPipeline(complaintId: string, userId: string) {
  return pipelineQueue.run(async () => {
    try {
      await runAgent(coordinatorAgent, { complaintId }, { complaintId, userId });
    } catch (e) {
      console.error('[pipeline]', complaintId, e);
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

/** Re-arm work that was in progress when the process restarted. */
export async function recoverOnBoot() {
  const drafted = await repo.listComplaintsByStatus(['drafted', 'submitting', 'analyzing']);
  for (const c of drafted) {
    if (c.status === 'submitting') {
      await repo.updateComplaint(c.id, { status: 'drafted', submit_after: new Date().toISOString() });
      scheduleSubmission(c.id, Date.now() + 2000);
    } else if (c.status === 'drafted' && c.submit_after) {
      scheduleSubmission(c.id, new Date(c.submit_after).getTime());
    } else if (c.status === 'analyzing') {
      void startPipeline(c.id, c.user_id);
    }
  }
}

export function startCron() {
  if (!config.enableCron) return;
  cron.schedule(config.monitorCron, () => {
    runMonitorSweep().catch((e) => console.error('[cron monitor]', e));
  }, { timezone: 'Asia/Kolkata' });
  console.log(`[cron] monitoring sweep scheduled: "${config.monitorCron}" (Asia/Kolkata)`);
}
