/**
 * One-time sign-in for the MCP server, with the same email code the app uses.
 *
 *   npm run mcp:login -- you@example.com          → emails a sign-in code
 *   npm run mcp:login -- you@example.com 123456   → checks the code and saves the session
 *
 * Supabase URL and anon key come from NAGRIK_SUPABASE_URL / NAGRIK_SUPABASE_ANON_KEY, falling back to
 * the app's preview build profile in mobile/eas.json (both are public values shipped in the app).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SESSION_FILE, saveSession, supabaseAuth } from '../src/mcp/session.js';

function supabaseConfig() {
  let url = process.env.NAGRIK_SUPABASE_URL;
  let key = process.env.NAGRIK_SUPABASE_ANON_KEY;
  if (!url || !key) {
    try {
      const env = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../mobile/eas.json'), 'utf8')).build.preview.env;
      url ||= env.EXPO_PUBLIC_SUPABASE_URL;
      key ||= env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    } catch {}
  }
  if (!url || !key) throw new Error('Set NAGRIK_SUPABASE_URL and NAGRIK_SUPABASE_ANON_KEY.');
  return { url, key };
}

const [email, code] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run mcp:login -- <email> [code]');
  process.exit(1);
}
const { url, key } = supabaseConfig();

if (!code) {
  // create_user: false — only accounts that already signed in through the app.
  await supabaseAuth(url, key, 'otp', { email, create_user: false });
  console.log(`Sign-in code sent to ${email}. Then run: npm run mcp:login -- ${email} <code>`);
} else {
  const j = await supabaseAuth(url, key, 'verify', { type: 'email', email, token: code });
  saveSession({ supabase_url: url, anon_key: key, email, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + j.expires_in });
  console.log(`Signed in as ${email}. Session saved to ${SESSION_FILE}`);
}
