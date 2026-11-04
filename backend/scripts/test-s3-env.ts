/** Imported first by test-s3.ts: S3 photo mode with fake credentials, everything else offline. */
import fs from 'node:fs';
import path from 'node:path';

export const S3_TEST_PORT = 4193;
const dir = '.data-test-s3';
fs.rmSync(path.resolve(dir), { recursive: true, force: true });

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: String(S3_TEST_PORT),
  PUBLIC_BASE_URL: `http://127.0.0.1:${S3_TEST_PORT}`,
  LOCAL_DATA_DIR: dir,
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  GEMINI_API_KEY: '',
  GOOGLE_GENERATIVE_AI_API_KEY: '',
  LANGFUSE_PUBLIC_KEY: '',
  LANGFUSE_SECRET_KEY: '',
  RESEND_API_KEY: '',
  ENABLE_CRON: 'false',
  PHOTO_STORAGE: 's3',
  S3_BUCKET: 'nagrik-photos-test',
  AWS_REGION: 'ap-south-1',
  // Fake keys only so the presigner can sign locally; the S3 client itself is mocked.
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFORTESTS0000',
  AWS_SECRET_ACCESS_KEY: 'fake-secret-for-unit-tests-only',
});
