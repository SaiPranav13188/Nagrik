/**
 * Creates (or resets) the Google Play review account: email + a fixed 6-digit password that the
 * reviewer types into the app's code box. Prints the password once; put it in Play Console →
 * App access. Add the email to REVIEW_EMAILS on Render so its complaints only go to the sandbox.
 *
 *   npx tsx scripts/create-review-account.ts <email>
 */
import { randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';

const email = process.argv[2]?.toLowerCase();
if (!email) throw new Error('Usage: create-review-account.ts <email>');
const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, { auth: { persistSession: false } });
const password = String(randomInt(100000, 1000000));

const { data: list, error: listError } = await sb.auth.admin.listUsers({ perPage: 1000 });
if (listError) throw listError;
let user = list.users.find((u) => u.email?.toLowerCase() === email);
if (user) {
  const { error } = await sb.auth.admin.updateUserById(user.id, { password });
  if (error) throw error;
} else {
  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  user = data.user;
}
const { error } = await sb.from('profiles').upsert({ id: user.id, full_name: 'Play Reviewer', phone: '9000000001', email, updated_at: new Date().toISOString() });
if (error) throw error;
console.log(`Review account ready: ${email}\nCode / password: ${password}`);
