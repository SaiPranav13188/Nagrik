/**
 * S3 photo storage (PHOTO_STORAGE=s3, the AWS deployment) with a mocked S3 client: uploads go to
 * the right bucket and key, the stored link is our /photos/ URL (never a public S3 link), viewing
 * it redirects to a 5-minute pre-signed URL, other users' and unsafe paths are refused, and account
 * deletion removes every photo under the user's folder.
 */
import { S3_TEST_PORT } from './test-s3-env.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, deleteUserPhotos, isSafeKey } from '../src/services/s3Photos.js';
import { isOwnPhotoUrl, loadPhoto, savePhoto } from '../src/services/storage.js';
import { productionSecretProblems } from '../src/config.js';
import { app } from '../src/app.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const s3Mock = mockClient(s3);
const server = app.listen(S3_TEST_PORT);
const base = `http://127.0.0.1:${S3_TEST_PORT}`;
const user = '11111111-2222-3333-4444-555555555555';

async function main() {
  s3Mock.on(PutObjectCommand).resolves({});
  const url = await savePhoto(user, Buffer.from('fake-jpeg'), 'image/jpeg');
  const put = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
  check('upload goes to the configured bucket under the user folder', put?.Bucket === 'nagrik-photos-test' && !!put?.Key?.startsWith(`${user}/`) && put?.ContentType === 'image/jpeg', put);
  check('stored link is our /photos/ URL, not a public S3 link', url.startsWith(`${base}/photos/${user}/`) && !url.includes('amazonaws.com'), url);
  check('the uploader owns the photo link', isOwnPhotoUrl(url, user));
  check("another user can't claim it", !isOwnPhotoUrl(url, '99999999-2222-3333-4444-555555555555'));

  s3Mock.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('fake-jpeg')) } as never, ContentType: 'image/jpeg' });
  const loaded = await loadPhoto(url);
  check('agents read the photo straight from S3', loaded.data.toString() === 'fake-jpeg' && loaded.mimeType === 'image/jpeg', loaded);

  const res = await fetch(url, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? '';
  check('opening the link redirects to a pre-signed S3 URL', res.status === 302 && loc.includes('nagrik-photos-test') && loc.includes('X-Amz-Signature='), { status: res.status, loc });
  check('the pre-signed URL expires after 5 minutes', loc.includes('X-Amz-Expires=300'), loc);
  check('path tricks are refused', (await fetch(`${base}/photos/${user}/..%2F..%2Fsecret`, { redirect: 'manual' })).status === 400);
  check('unsafe keys are rejected', !isSafeKey('../x') && !isSafeKey('a/b/c') && !isSafeKey('/abs') && isSafeKey(`${user}/1-ab.jpg`));

  s3Mock.on(ListObjectsV2Command)
    .resolvesOnce({ Contents: [{ Key: `${user}/a.jpg` }, { Key: `${user}/b.jpg` }], IsTruncated: true, NextContinuationToken: 't1' })
    .resolvesOnce({ Contents: [{ Key: `${user}/c.jpg` }], IsTruncated: false });
  s3Mock.on(DeleteObjectsCommand).resolves({});
  const removed = await deleteUserPhotos(user);
  const listed = s3Mock.commandCalls(ListObjectsV2Command).map((c) => c.args[0].input.Prefix);
  check('account deletion removes every photo, across pages', removed === 3 && s3Mock.commandCalls(DeleteObjectsCommand).length === 2, { removed });
  check("deletion only lists this user's folder", listed.every((p) => p === `${user}/`), listed);

  check('production refuses PHOTO_STORAGE=s3 without a bucket', productionSecretProblems({ ...process.env, S3_BUCKET: '' }).some((p) => p.includes('S3_BUCKET')));
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    server.close();
    console.log(failures ? `\n${failures} S3 check(s) failed` : '\nAll S3 checks passed');
    process.exit(failures ? 1 : 0);
  });
