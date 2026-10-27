/**
 * Checks the in-app help assistant. Every case must pass — a wrong help answer is a bug.
 *
 *   npm run eval:help -- --offline   # keyword routing, status answers, button names (what CI runs)
 *   npm run eval:help                # also the Gemini classifier and AI fallback (needs GEMINI_API_KEY)
 *
 * Offline, questions that need the AI must come back as "not sure → Email support", never a guess.
 */
import './eval-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from '../src/db/index.js';
import { useGemini } from '../src/config.js';
import { shutdownTracing } from '../src/ai/tracing.js';
import { answerHelp, matchTopic, type HelpReply } from '../src/services/help.js';
import { FIXED_REPLIES, HELP_TOPICS, type HelpLang } from '../src/services/helpAnswers.js';

interface Case {
  q: string;
  lang?: HelpLang;
  intent?: string;
  /** Expected topic id ("my_complaint" for status answers), "ai_or_none" for questions no fixed answer covers; "a|b" accepts either. */
  topic: string;
  /** Needs the Gemini classifier (no keyword match by design). */
  ai?: boolean;
  contains?: string[];
  notContains?: string[];
}

const CASES: Case[] = [
  // Suggestions in the app send their topic directly.
  { q: 'What does "Action needed" mean?', intent: 'action_needed', topic: 'action_needed', contains: ["I've submitted it", 'Retry automatic filing'] },
  { q: "What's happening with my complaint?", intent: 'my_complaint', topic: 'my_complaint', contains: ['WNP/2026/000003'] },
  { q: 'How does escalation work?', intent: 'escalation', topic: 'escalation', contains: ["Don't send"] },

  // Keyword routing (English).
  { q: 'there is a live wire hanging on our street', topic: 'emergency', contains: ['112'] },
  { q: 'How do I report a pothole?', topic: 'how_to_report' },
  { q: 'Why does it say action needed', topic: 'action_needed' },
  { q: 'the portal is asking for captcha', topic: 'action_needed' },
  { q: 'what is the review window before filing?', topic: 'auto_submit' },
  { q: 'can I edit the complaint letter before it goes?', topic: 'edit_complaint' },
  { q: 'How can I delete my complaint?', topic: 'withdraw_complaint', contains: ['Withdraw complaint'] },
  { q: 'please delete my account', topic: 'delete_account', contains: ['Delete everything'] },
  { q: 'when will you check status again', topic: 'status_checks' },
  { q: 'how do I escalate to a senior officer', topic: 'escalation', contains: ['no button'] },
  { q: 'how do I mark it as fixed', topic: 'is_it_fixed' },
  { q: 'what is test portal?', topic: 'test_portal' },
  { q: 'someone already reported this, what do I do', topic: 'me_too' },
  { q: 'the app picked the wrong department', topic: 'wrong_info' },
  { q: "I didn't get the code in my email", topic: 'sign_in' },
  { q: 'how to change my mobile number', topic: 'profile' },
  { q: 'how do I change the language', topic: 'language' },
  { q: 'notifications are not coming', topic: 'notifications' },
  { q: 'who can see my phone number?', topic: 'privacy' },
  { q: 'the app keeps loading', topic: 'slow_app' },
  { q: 'location permission denied, what now', topic: 'location' },
  { q: 'Is this a government app?', topic: 'about' },

  // Status answers are built from the data.
  { q: 'any update on WNP/2026/000003?', topic: 'my_complaint', contains: ['WNP/2026/000003', 'Filed with', 'Next automatic check', 'test portal'], notContains: ['CAPTCHA'] },
  { q: 'what happened to my complaints', topic: 'my_complaint', contains: ['WNP/2026/000003', 'CAPTCHA', 'Retry automatic filing'], notContains: ['Marked fixed'] },
  { q: 'నా ఫిర్యాదు స్థితి ఏమిటి?', lang: 'te', topic: 'my_complaint', contains: ['WNP/2026/000003', 'తదుపరి ఆటోమేటిక్ చెక్'] },
  { q: 'मेरी शिकायत का क्या हाल है?', lang: 'hi', topic: 'my_complaint', contains: ['WNP/2026/000003', 'अगली अपने-आप जाँच'] },
  { q: 'status of WNP/2026/000555?', topic: 'my_complaint', contains: ["can't be checked automatically", 'Is it fixed?'], notContains: ['Next automatic check', 'test portal'] },

  // Keyword routing (Telugu / Hindi) answers in that language.
  { q: 'ఎస్కలేషన్ అంటే ఏమిటి?', lang: 'te', topic: 'escalation', contains: ['పంపవద్దు'] },
  { q: 'खाता हटाना है', lang: 'hi', topic: 'delete_account', contains: ['सब कुछ हटाएँ'] },
  { q: 'लॉगिन कोड नहीं आया', lang: 'hi', topic: 'sign_in' },

  // Must NOT be caught by the wrong keyword.
  { q: 'streetlight not working near the school, how do I report it?', topic: 'how_to_report' },

  // No keyword match: the classifier decides; offline these must hand off to email.
  { q: 'tell me a joke about cats', topic: 'off_topic', ai: true },
  { q: 'nenu complaint pettanu kani emi jaragaledu', topic: 'my_complaint', ai: true },
  { q: 'garbage truck never comes to our colony, whom should I tell?', topic: 'how_to_report|ai_or_none', ai: true },
  { q: 'can I attach two photos to one complaint?', topic: 'how_to_report', ai: true, contains: ['one photo'] },
  { q: 'which government office handles water tankers in Hyderabad?', topic: 'ai_or_none', ai: true, notContains: ['GHMC', 'HMWSSB', '1800'] },
];

const offline = !useGemini;
const USER = '00000000-0000-4000-8000-0000000e1a01';
const day = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function seed() {
  await repo.upsertProfile({ id: USER, full_name: 'Eval Citizen', phone: '9876543210' });
  const sandbox = (await repo.listJurisdictions()).find((j) => j.is_sandbox) ?? null;
  await repo.createComplaint({
    user_id: USER, issue_type: 'drainage', status: 'submitted', tracking_id: 'WNP/2026/000003', address: 'Gandhi Chowk, Wanaparthy', city: 'Wanaparthy',
    jurisdiction_department: 'Wanaparthy Municipality – Drains', jurisdiction_portal_id: sandbox?.id ?? null, submitted_at: iso(5 * day), last_checked_at: iso(1 * day), created_at: iso(5 * day),
  } as never);
  await repo.createComplaint({
    user_id: USER, issue_type: 'pothole', status: 'submission_failed', failure_reason: 'The portal asked for a CAPTCHA.', address: 'Main Road, Wanaparthy', city: 'Wanaparthy',
    jurisdiction_department: 'Wanaparthy Municipality – Roads', created_at: iso(2 * day),
  } as never);
  await repo.createComplaint({ user_id: USER, issue_type: 'garbage', status: 'resolved', resolved_at: iso(20 * day), created_at: iso(30 * day) } as never);
  // Filed by the citizen on the real (OTP-gated) portal: no status page the app can read.
  const live = (await repo.listJurisdictions()).find((j) => !j.is_sandbox && j.city === 'Wanaparthy' && !j.status_check_url_template) ?? null;
  await repo.createComplaint({
    user_id: USER, issue_type: 'streetlight', status: 'submitted', tracking_id: 'WNP/2026/000555', city: 'Wanaparthy', jurisdiction_portal_id: live?.id ?? null,
    jurisdiction_department: 'Wanaparthy Municipality – Electrical', submitted_at: iso(2 * day), created_at: iso(2 * day),
  } as never);
  return sandbox;
}

/** Every phrase quoted in a fixed answer must be a real label in the app, in that language. */
function checkButtonNames(): string[] {
  const src = fs.readFileSync(path.resolve('../mobile/src/lib/i18n.tsx'), 'utf8');
  const block = (from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));
  const values = (b: string) => new Set([...b.matchAll(/^\s+\w+:\s*(['"])(.*?)\1,?$/gm)].map((m) => m[2].replace(/\\(['"])/g, '$1')));
  const dict: Record<HelpLang, Set<string>> = { en: values(block('const en =', 'export type TKey')), te: values(block('const te: Dict', 'const hi: Dict')), hi: values(block('const hi: Dict', 'const DICTS')) };
  const problems: string[] = [];
  for (const t of HELP_TOPICS) {
    for (const lang of ['en', 'te', 'hi'] as const) {
      const text = t.answer()[lang];
      if (!text?.trim()) problems.push(`${t.id}/${lang}: missing`);
      // A quote opens/closes only next to a non-letter, so apostrophes (isn't, I've) don't count.
      for (const m of text.matchAll(/(?<!\p{L})'(.{2,60}?)'(?!\p{L})/gu)) {
        const label = m[1].replace(/\s*…$/, '').replace(/ in$/, '');
        const known = [...dict[lang]].some((v) => v === label || v.startsWith(label) || v.replace(/ ?\{\w+\}$/, '') === label);
        if (!known) problems.push(`${t.id}/${lang}: button '${label}' is not a label in the app`);
      }
    }
  }
  return problems;
}

function checkReply(c: Case, r: HelpReply): string | null {
  const lang = c.lang ?? 'en';
  if (offline && c.ai) {
    return r.source === 'none' && r.handoff && r.reply === FIXED_REPLIES.not_sure[lang] ? null : `offline must hand off to email, got ${r.source}/${r.topic}`;
  }
  const accepted = c.topic.split('|');
  if (accepted.includes('ai_or_none') && (r.source === 'ai' || r.source === 'none')) {
    for (const s of c.notContains ?? []) if (r.reply.includes(s)) return `reply should not contain "${s}" (made-up facts)`;
    return null;
  }
  if (!accepted.includes(r.topic ?? '')) return `expected topic ${c.topic}, got ${r.topic} (${r.source})`;
  for (const s of c.contains ?? []) if (!r.reply.includes(s)) return `reply is missing "${s}"`;
  for (const s of c.notContains ?? []) if (r.reply.includes(s)) return `reply should not contain "${s}"`;
  return null;
}

async function main() {
  const sandbox = await seed();
  const failures: string[] = checkButtonNames();
  if (!sandbox) failures.push('setup: no sandbox jurisdiction in the seed data');

  // Keyword routing never depends on the AI.
  for (const c of CASES.filter((x) => !x.ai && !x.intent)) {
    const m = matchTopic(c.q);
    if (m !== c.topic) failures.push(`[keywords] "${c.q}": expected ${c.topic}, got ${m}`);
  }
  for (const c of CASES.filter((x) => x.ai)) {
    const m = matchTopic(c.q);
    if (m) failures.push(`[keywords] "${c.q}": should be left to the classifier, but matched ${m}`);
  }

  for (const c of CASES) {
    if (useGemini && c.ai) await new Promise((r) => setTimeout(r, 5000)); // free tier pacing
    const r = await answerHelp({ userId: USER, messages: [{ role: 'user', content: c.q }], lang: c.lang ?? 'en', intent: c.intent });
    const problem = checkReply(c, r);
    console.log(`${problem ? '✗' : '✓'} [${r.source}/${r.topic}] ${c.q}${problem ? `\n    → ${problem}\n    reply: ${r.reply.slice(0, 300)}` : ''}`);
    if (problem) failures.push(`"${c.q}": ${problem}`);
  }

  console.log(`\nMode: ${offline ? 'offline (no AI)' : 'gemini'} · ${CASES.length} questions · ${HELP_TOPICS.length} fixed topics × 3 languages`);
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log('All help answers correct.');
  await shutdownTracing();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
