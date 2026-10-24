/**
 * Saved Supabase sign-in for the MCP server, so it can act as a real app user without a token
 * that expires every hour. Created once with `npm run mcp:login`; the server refreshes it.
 *
 * Stored at ~/.nagrik/mcp-session.json (override with NAGRIK_MCP_SESSION). It holds a refresh
 * token, so it is as sensitive as a password: keep it out of the repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type McpSession = {
  supabase_url: string;
  anon_key: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
};

export const SESSION_FILE = process.env.NAGRIK_MCP_SESSION || path.join(os.homedir(), '.nagrik', 'mcp-session.json');

export function loadSession(): McpSession | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as McpSession;
  } catch {
    return null;
  }
}

export function saveSession(s: McpSession) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** Calls a Supabase Auth endpoint and turns a token response into a session. */
export async function supabaseAuth(url: string, anonKey: string, route: string, body: unknown) {
  const r = await fetch(`${url.replace(/\/$/, '')}/auth/v1/${route}`, {
    method: 'POST',
    headers: { apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(j.msg || j.error_description || j.error || `Supabase Auth ${r.status}`);
  return j;
}

/** Returns a valid access token, refreshing (and re-saving, since refresh tokens rotate) when close to expiry. */
export async function sessionToken(): Promise<string | null> {
  const s = loadSession();
  if (!s) return null;
  if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  const j = await supabaseAuth(s.supabase_url, s.anon_key, 'token?grant_type=refresh_token', { refresh_token: s.refresh_token }).catch((e) => {
    throw new Error(`Saved Nagrik sign-in no longer works (${(e as Error).message}). Run: npm run mcp:login -- <email>`);
  });
  saveSession({ ...s, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + j.expires_in });
  return j.access_token;
}
