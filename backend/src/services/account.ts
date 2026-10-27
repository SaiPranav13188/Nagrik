import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { SupabaseRepo } from '../db/supabaseRepo.js';
import { deleteTraces } from '../ai/tracing.js';
import { holdSubmission } from './scheduler.js';
import { uploadsDir } from './storage.js';

/**
 * Account deletion (Play policy + DPDP): removes the user's complaints, photos, notifications,
 * "Me too" supports, profile, their Langfuse traces and finally the sign-in account itself.
 * Complaints already filed with a government office stay in that office's own system; we can't
 * delete those, and the privacy policy says so.
 */
export async function deleteAccount(userId: string) {
  const complaints = await repo.listComplaintsByUser(userId);
  for (const c of complaints) await holdSubmission(c.id).catch(() => {});

  let traces: number | string = 0;
  try {
    traces = await deleteTraces({ userId, complaintIds: complaints.map((c) => c.id) });
  } catch (e) {
    traces = `failed: ${(e as Error).message}`;
    console.error('[account] trace deletion failed', (e as Error).message);
  }

  let photos = 0;
  if (repo instanceof SupabaseRepo) {
    const bucket = repo.client.storage.from(config.supabasePhotoBucket);
    for (;;) {
      const { data, error } = await bucket.list(userId, { limit: 100 });
      if (error) throw new Error(`Photo listing failed: ${error.message}`);
      if (!data?.length) break;
      const { error: rmError } = await bucket.remove(data.map((f) => `${userId}/${f.name}`));
      if (rmError) throw new Error(`Photo deletion failed: ${rmError.message}`);
      photos += data.length;
    }
  } else {
    const dir = path.join(uploadsDir, userId);
    if (fs.existsSync(dir)) {
      photos = fs.readdirSync(dir).length;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  await repo.deleteUserData(userId);
  if (repo instanceof SupabaseRepo) {
    const { error } = await repo.client.auth.admin.deleteUser(userId);
    if (error) throw new Error(`Sign-in account deletion failed: ${error.message}`);
  }
  console.log(`[account] deleted user data: ${complaints.length} complaint(s), ${photos} photo(s), traces ${traces}`);
  return { complaints: complaints.length, photos, traces };
}
