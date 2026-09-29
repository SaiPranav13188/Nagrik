import 'dotenv/config';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
}

const port = num(process.env.PORT, 4000);

export const config = {
  port,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  nodeEnv: process.env.NODE_ENV || 'development',

  // AI
  geminiApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY || '',
  // Agent reasoning makes many calls per complaint → the Lite model (higher free-tier limits).
  // Photo analysis is one call per complaint → the full Flash model. Quotas are per model.
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  geminiVisionModel: process.env.GEMINI_VISION_MODEL || 'gemini-flash-latest',

  // Data
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabasePhotoBucket: process.env.SUPABASE_PHOTO_BUCKET || 'complaint-photos',
  localDataDir: process.env.LOCAL_DATA_DIR || '.data',

  // Auth (local mode only: HMAC-signed device tokens)
  localAuthSecret: process.env.LOCAL_AUTH_SECRET || 'dev-only-change-me',
  adminApiKey: process.env.ADMIN_API_KEY || 'admin-dev-key',
  cronSecret: process.env.CRON_SECRET || 'cron-dev-secret',

  // Portals: "sandbox" routes auto-submission to the bundled mock portal; "live" uses real portals.
  portalMode: (process.env.PORTAL_MODE === 'live' ? 'live' : 'sandbox') as 'live' | 'sandbox',
  // In sandbox mode, complaints from cities without a mapping fall back to the Wanaparthy sandbox
  // portal so the full loop can be demoed from anywhere. Never applies in live mode.
  sandboxMatchAnyCity: bool(process.env.SANDBOX_MATCH_ANY_CITY, true),
  submissionGraceSeconds: num(process.env.SUBMISSION_GRACE_SECONDS, 15),
  headless: bool(process.env.PLAYWRIGHT_HEADLESS, true),

  // Monitoring
  monitorCron: process.env.MONITOR_CRON || '0 9 * * *',
  recheckIntervalHours: num(process.env.RECHECK_INTERVAL_HOURS, 72),
  escalationThresholdDays: num(process.env.ESCALATION_THRESHOLD_DAYS, 10),
  enableCron: bool(process.env.ENABLE_CRON, true),

  // Escalation email (Resend)
  resendApiKey: process.env.RESEND_API_KEY || '',
  escalationFromEmail: process.env.ESCALATION_FROM_EMAIL || 'Nagrik <escalations@nagrik.app>',
  allowLiveEscalationEmails: bool(process.env.ALLOW_LIVE_ESCALATION_EMAILS, false),
  sandboxEscalationEmail: process.env.SANDBOX_ESCALATION_EMAIL || '',

  // Nominatim requires an identifying User-Agent
  nominatimUserAgent: process.env.NOMINATIM_USER_AGENT || 'Nagrik-CivicComplaints/1.0 (contact: admin@nagrik.app)',
};

export const useSupabase = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
export const useGemini = Boolean(config.geminiApiKey);
if (config.geminiApiKey && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.geminiApiKey;
}
