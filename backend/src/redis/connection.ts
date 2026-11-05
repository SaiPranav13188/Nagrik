import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config.js';

/**
 * Redis connections. Redis is optional: without REDIS_URL every helper here is a no-op and the
 * app falls back to in-process queues and limits. Supabase is always the source of truth, so
 * losing Redis (Render's free Key Value keeps nothing across restarts) never loses a complaint.
 */
export const redisEnabled = Boolean(config.redisUrl);

/** Every key Nagrik writes starts with this, so several apps or test runs can share one Redis. */
export const key = (...parts: Array<string | number>) => [config.redisPrefix, ...parts].join(':');

let lastErrorLog = 0;
function make(name: string, opts: RedisOptions) {
  const r = new Redis(config.redisUrl, { connectionName: `nagrik-${name}`, ...opts });
  r.on('error', (err) => {
    // ioredis retries forever and emits an error on every attempt; one line every 30 s is enough.
    if (Date.now() - lastErrorLog < 30_000) return;
    lastErrorLog = Date.now();
    console.error(`[redis] ${name} connection error:`, err.message);
  });
  return r;
}

let blocking: Redis | null = null;
let fast: Redis | null = null;

/** For BullMQ workers, which REQUIRE maxRetriesPerRequest: null (commands wait for a reconnect). */
export function workerConnection(): Redis {
  if (!redisEnabled) throw new Error('REDIS_URL is not set');
  return (blocking ??= make('worker', { maxRetriesPerRequest: null }));
}

/**
 * For everything on the request path (adding jobs, cache, rate limits). Fails fast instead of
 * queueing commands while Redis is down, so a Redis outage can never make a request hang.
 */
export function fastConnection(): Redis | null {
  if (!redisEnabled) return null;
  return (fast ??= make('fast', { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 2000, connectTimeout: 5000 }));
}

/** True only while the request-path connection is up. Queue calls check this first, so they never wait on a dead Redis. */
export function redisReady() {
  return fastConnection()?.status === 'ready';
}

/** Rejects if a Redis call takes longer than ms (a slow Redis must not hold up a request). */
export function withTimeout<T>(p: Promise<T>, ms = 5000, what = 'Redis call'): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Resolves once the fast connection is ready (or after timeoutMs). Returns whether it is. */
export async function waitForRedis(timeoutMs = 5000): Promise<boolean> {
  const r = fastConnection();
  if (!r) return false;
  if (r.status === 'ready') return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      r.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(t);
      resolve(true);
    };
    r.once('ready', onReady);
  });
}

export async function redisHealth(): Promise<'off' | 'ok' | string> {
  const r = fastConnection();
  if (!r) return 'off';
  try {
    return (await r.ping()) === 'PONG' ? 'ok' : 'error: unexpected ping reply';
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export async function closeRedis() {
  await Promise.all([blocking?.quit().catch(() => {}), fast?.quit().catch(() => {})]);
  blocking = fast = null;
}
