/**
 * Imported first by test-failures.ts so these settings win over backend/.env. Tests run fully
 * offline and deterministic: local JSON store, offline planner, sandbox portal, no email, no cron.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TEST_PORT = 4191;
const dir = '.data-test';
fs.rmSync(path.resolve(dir), { recursive: true, force: true });

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: String(TEST_PORT),
  PUBLIC_BASE_URL: `http://127.0.0.1:${TEST_PORT}`,
  LOCAL_DATA_DIR: dir,
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  GEMINI_API_KEY: '',
  GOOGLE_GENERATIVE_AI_API_KEY: '',
  LANGFUSE_PUBLIC_KEY: '',
  LANGFUSE_SECRET_KEY: '',
  RESEND_API_KEY: '',
  PORTAL_MODE: 'sandbox',
  SANDBOX_MATCH_ANY_CITY: 'false',
  SUBMISSION_GRACE_SECONDS: '600',
  ENABLE_CRON: 'false',
  ADMIN_API_KEY: 'test-admin-key-0123456789abcdef',
  CRON_SECRET: 'test-cron-secret-0123456789abcdef',
  LOCAL_AUTH_SECRET: 'test-local-auth-secret-0123456789',
});
