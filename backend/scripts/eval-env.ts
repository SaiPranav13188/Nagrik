/**
 * Imported first by the eval so these settings win over backend/.env (dotenv never overrides a
 * variable that is already set, even to ""). The eval must never touch Supabase, real portals,
 * email or the cron — it only runs the Intake, Jurisdiction and Drafting agents.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.EVAL_DATA_DIR || '.data-eval';
fs.rmSync(path.resolve(dir), { recursive: true, force: true });

Object.assign(process.env, {
  LOCAL_DATA_DIR: dir,
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  // Live mappings: out-of-area complaints must NOT fall back to the sandbox portal here.
  PORTAL_MODE: 'live',
  SANDBOX_MATCH_ANY_CITY: 'false',
  ENABLE_CRON: 'false',
  RESEND_API_KEY: '',
});
if (process.argv.includes('--offline')) Object.assign(process.env, { GEMINI_API_KEY: '', GOOGLE_GENERATIVE_AI_API_KEY: '' });
