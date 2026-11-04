import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

/**
 * Complaint photos in a private S3 bucket (used only when PHOTO_STORAGE=s3, i.e. the AWS deployment).
 * No keys here: on ECS the task role supplies credentials; locally, your own AWS CLI profile does.
 * The database stores a stable app URL (/photos/<key>); opening it redirects to a 5-minute
 * pre-signed S3 URL, so the bucket itself is never public.
 */
export const s3 = new S3Client({ region: config.awsRegion });
const Bucket = () => config.s3Bucket;

export const PRESIGN_SECONDS = 300;
export const photosPrefix = () => `${config.publicBaseUrl}/photos/`;

export async function putPhoto(key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: body, ContentType: contentType }));
}

export async function photoUrl(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: Bucket(), Key: key }), { expiresIn: PRESIGN_SECONDS });
}

export async function getPhoto(key: string): Promise<{ data: Buffer; mimeType: string }> {
  const r = await s3.send(new GetObjectCommand({ Bucket: Bucket(), Key: key }));
  const bytes = await r.Body!.transformToByteArray();
  return { data: Buffer.from(bytes), mimeType: r.ContentType || 'image/jpeg' };
}

/** Deletes every photo under "<userId>/" (account deletion). Returns how many were removed. */
export async function deleteUserPhotos(userId: string) {
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: Bucket(), Prefix: `${userId}/`, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: Bucket(), Delete: { Objects: keys, Quiet: true } }));
      removed += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

/** "<userId>/<file>" only — blocks "..", absolute paths and anything outside a user folder. */
export function isSafeKey(key: string) {
  return /^[\w-]+\/[\w.-]+$/.test(key) && !key.includes('..');
}
