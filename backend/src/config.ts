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
  maxEscalationEmailsPerDay: num(process.env.MAX_ESCALATION_EMAILS_PER_DAY, 3),

  // Browser origins allowed to call the API in production (comma-separated). The app needs none.
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),

  // Nominatim requires an identifying User-Agent
  nominatimUserAgent: process.env.NOMINATIM_USER_AGENT || 'Nagrik-CivicComplaints/1.0 (contact: admin@nagrik.app)',

  // Tracing (https://langfuse.com). Off unless both keys are set.
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY || '',
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY || '',
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com',
  // USD per 1M tokens, used for the cost shown on each traced model call. Override with
  // MODEL_PRICES='{"model-id":{"input":0.1,"output":0.4}}' when Google changes prices.
  modelPrices: parsePrices(process.env.MODEL_PRICES),
};

function parsePrices(v: string | undefined): Record<string, { input: number; output: number }> {
  const defaults = {
    'gemini-flash-lite-latest': { input: 0.1, output: 0.4 },
    'gemini-flash-latest': { input: 0.3, output: 2.5 },
  };
  if (!v) return defaults;
  try {
    return { ...defaults, ...JSON.parse(v) };
  } catch {
    console.warn('[config] MODEL_PRICES is not valid JSON; using defaults');
    return defaults;
  }
}

export const useSupabase = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);

const DEV_DEFAULTS = new Set(['admin-dev-key', 'cron-dev-secret', 'dev-only-change-me', 'changeme', 'change-me']);

/**
 * In production every secret must be set to a long, non-default value — otherwise anyone who has
 * read this repo could open the admin console or trigger jobs. Returns the problems found.
 */
export function productionSecretProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const required: Array<[string, string | undefined]> = [
    ['ADMIN_API_KEY', env.ADMIN_API_KEY],
    ['CRON_SECRET', env.CRON_SECRET],
  ];
  // Device-token signing is only used without Supabase.
  if (!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) required.push(['LOCAL_AUTH_SECRET', env.LOCAL_AUTH_SECRET]);
  const problems: string[] = [];
  for (const [name, value] of required) {
    if (!value) problems.push(`${name} is not set`);
    else if (DEV_DEFAULTS.has(value)) problems.push(`${name} is still the development default`);
    else if (value.length < 24) problems.push(`${name} must be at least 24 characters`);
  }
  return problems;
}
export const useGemini = Boolean(config.geminiApiKey);
if (config.geminiApiKey && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.geminiApiKey;
}
