import { fastConnection, key } from './connection.js';

/** Hit/miss counters for this process (shown on /admin/stats) — the cache's measured benefit. */
export const cacheStats: Record<string, { hits: number; misses: number }> = {};
const count = (name: string, hit: boolean) => {
  const s = (cacheStats[name] ??= { hits: 0, misses: 0 });
  if (hit) s.hits++;
  else s.misses++;
};

/**
 * Return the cached value, or run loader() and cache its result for ttlSec.
 * Never breaks the app: if Redis is off or down it just calls loader().
 * loader() returning null/undefined means "don't cache this" (uncertain or failed results).
 */
export async function getOrSet<T>(name: string, id: string, ttlSec: number, loader: () => Promise<T | null | undefined>): Promise<T | null> {
  const redis = fastConnection();
  const k = key('cache', name, id);
  if (redis) {
    try {
      const hit = await redis.get(k);
      if (hit !== null) {
        count(name, true);
        return JSON.parse(hit) as T;
      }
    } catch (e) {
      console.warn(`[cache] ${name} read failed:`, (e as Error).message);
    }
  }
  count(name, false);
  const value = await loader();
  if (value == null) return null;
  if (redis) {
    try {
      await redis.set(k, JSON.stringify(value), 'EX', ttlSec);
    } catch (e) {
      console.warn(`[cache] ${name} write failed:`, (e as Error).message);
    }
  }
  return value;
}

/** Drop every cached entry of one kind (e.g. after an admin changes a jurisdiction). */
export async function clearCache(name: string) {
  const redis = fastConnection();
  if (!redis) return 0;
  let removed = 0;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', key('cache', name, '*'), 'COUNT', 200);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== '0');
  } catch (e) {
    console.warn(`[cache] clearing ${name} failed:`, (e as Error).message);
  }
  return removed;
}
