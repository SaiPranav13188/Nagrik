import { fastConnection, key, redisEnabled } from '../redis/connection.js';

/**
 * Guard against filing the same complaint twice on a real portal.
 *
 * The queue gives "at least once" delivery: if the process dies after the browser pressed Submit
 * but before Supabase says "submitted", the job is retried. So right before the browser starts
 * filling the form we write a marker, and remove it once we know the outcome. A marker that is
 * still there at the start of a new attempt means the last attempt stopped at an unknown point —
 * we then ask the citizen to check the portal instead of filing again.
 *
 * Without Redis there are no retries, so there is nothing to guard and these are no-ops.
 */
const TTL_SEC = 7 * 24 * 3600;
const markerKey = (complaintId: string) => key('submit-started', complaintId);

export async function markSubmitStarted(complaintId: string) {
  if (!redisEnabled) return;
  try {
    await fastConnection()!.set(markerKey(complaintId), new Date().toISOString(), 'EX', TTL_SEC);
  } catch (e) {
    console.warn('[submit-guard] could not set marker:', (e as Error).message);
  }
}

export async function clearSubmitStarted(complaintId: string) {
  if (!redisEnabled) return;
  try {
    await fastConnection()!.del(markerKey(complaintId));
  } catch (e) {
    console.warn('[submit-guard] could not clear marker:', (e as Error).message);
  }
}

/** True if an earlier attempt started filling the form and never reported how it ended. */
export async function submitStartedEarlier(complaintId: string): Promise<boolean> {
  if (!redisEnabled) return false;
  try {
    return (await fastConnection()!.exists(markerKey(complaintId))) === 1;
  } catch (e) {
    console.warn('[submit-guard] could not read marker:', (e as Error).message);
    return false;
  }
}
