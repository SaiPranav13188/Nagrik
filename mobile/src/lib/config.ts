import Constants from 'expo-constants';

/**
 * API base URL. Set EXPO_PUBLIC_API_URL for staging/production (e.g. your Render URL).
 * In development we derive the dev machine's LAN IP from Expo so a phone running Expo Go
 * can reach the local backend without any configuration.
 */
function deriveApiUrl() {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const hostUri = Constants.expoConfig?.hostUri ?? '';
  const host = hostUri.split(':')[0];
  return host ? `http://${host}:4000` : 'http://localhost:4000';
}

export const API_URL = deriveApiUrl();
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const USE_SUPABASE_AUTH = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const EAS_PROJECT_ID: string | undefined =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
export const SUPPORT_EMAIL = 'saipranav1388@gmail.com';
export const PRIVACY_POLICY_URL = 'https://saipranav13188.github.io/Nagrik/privacy/';

/** Backends in local mode return URLs built from PUBLIC_BASE_URL (often localhost). Point them at the API host we can reach. */
export function resolveMediaUrl(url: string | null | undefined) {
  if (!url) return null;
  return url.replace(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, API_URL);
}
