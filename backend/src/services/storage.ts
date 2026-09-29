import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { repo } from '../db/index.js';
import { SupabaseRepo } from '../db/supabaseRepo.js';

export const uploadsDir = path.resolve(config.localDataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

export async function savePhoto(userId: string, buffer: Buffer, mimeType: string): Promise<string> {
  const ext = EXT[mimeType] ?? 'jpg';
  const key = `${userId}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  if (repo instanceof SupabaseRepo) {
    const bucket = repo.client.storage.from(config.supabasePhotoBucket);
    const { error } = await bucket.upload(key, buffer, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return bucket.getPublicUrl(key).data.publicUrl;
  }
  const file = path.join(uploadsDir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return `${config.publicBaseUrl}/uploads/${key}`;
}

/** Returns image bytes for a stored photo URL (local file or remote). */
export async function loadPhoto(url: string): Promise<{ data: Buffer; mimeType: string }> {
  const localPrefix = `${config.publicBaseUrl}/uploads/`;
  if (url.startsWith(localPrefix)) {
    const rel = decodeURIComponent(url.slice(localPrefix.length));
    const file = path.resolve(uploadsDir, rel);
    if (!file.startsWith(uploadsDir)) throw new Error('Invalid photo path');
    const ext = path.extname(file).slice(1).toLowerCase();
    return { data: fs.readFileSync(file), mimeType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download photo (${res.status})`);
  return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get('content-type') || 'image/jpeg' };
}

/** Writes the photo to a temp file so Playwright can attach it to a portal's file input. */
export async function photoToTempFile(url: string): Promise<string> {
  const { data, mimeType } = await loadPhoto(url);
  const file = path.join(os.tmpdir(), `nagrik-${randomUUID()}.${EXT[mimeType] ?? 'jpg'}`);
  fs.writeFileSync(file, data);
  return file;
}
