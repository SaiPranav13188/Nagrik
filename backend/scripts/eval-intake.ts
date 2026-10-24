/**
 * Scores the Intake, Jurisdiction and Drafting agents.
 *
 *   npm run eval:intake                 # Gemini if GEMINI_API_KEY is set, else the offline planner
 *   npm run eval:intake -- --offline    # force the offline planner (what CI runs)
 *   npm run eval:intake -- --only c04,c36 --delay 6000
 *   npm run eval:intake -- --offline --check   # exit 1 if scores drop below eval/thresholds.json
 *
 * Cases come from eval/cases.synthetic.json (text-only, synthetic) and, if present,
 * eval/labels.csv + eval/photos/ (your own labelled photos):
 *      file,expected_issue_type,expected_department_contains,lat,lng,note
 *
 * Runs against a throwaway local store with live (not sandbox) mappings and never submits
 * anything. Results are written to eval/results/<mode>.json.
 */
import './eval-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { geminiAvailable, geminiErrorCount, runAgent } from '../src/ai/runtime.js';
import { shutdownTracing } from '../src/ai/tracing.js';
import { intakeAgent } from '../src/agents/intake.js';
import { jurisdictionAgent } from '../src/agents/jurisdiction.js';
import { draftingAgent } from '../src/agents/drafting.js';
import { repo } from '../src/db/index.js';
import { savePhoto } from '../src/services/storage.js';
import { primeGeocodeCache, type GeocodeResult } from '../src/services/geocode.js';
import { config, useGemini } from '../src/config.js';
import type { IssueType } from '../src/db/types.js';

interface EvalCase {
  id: string;
  tags?: string[];
  note: string | null;
  address: string | null;
  gps?: { lat: number; lng: number; geocode?: GeocodeResult };
  photo?: string;
  expect: {
    intake: 'save' | 'clarify' | 'reject';
    issue_type?: IssueType;
    department?: string | null;
    department_contains?: string;
    draft_must_mention?: string[];
    draft_must_not_mention?: string[];
  };
}

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const only = opt('--only')?.split(',');
// Free tier allows ~15 requests/minute and a case makes ~10, so pace Gemini runs.
const delayMs = Number(opt('--delay') ?? (useGemini ? 40000 : 0));
const modeKey = useGemini ? 'gemini' : 'offline';
const modeLabel = useGemini ? `gemini (${config.geminiModel} / ${config.geminiVisionModel})` : 'offline-planner';

const root = path.resolve('eval');
const cases: EvalCase[] = JSON.parse(fs.readFileSync(path.join(root, 'cases.synthetic.json'), 'utf8')).cases;

const csv = path.join(root, 'labels.csv');
if (fs.existsSync(csv)) {
  for (const line of fs.readFileSync(csv, 'utf8').trim().split(/\r?\n/).slice(1).filter(Boolean)) {
    const [file, issue, dept, lat, lng, note] = line.split(',').map((s) => s.trim());
    cases.push({
      id: `photo:${file}`,
      tags: ['photo'],
      photo: file,
      note: note || null,
      address: null,
      gps: lat ? { lat: Number(lat), lng: Number(lng) } : undefined,
      expect: { intake: 'save', issue_type: issue as IssueType, department_contains: dept || undefined },
    });
  }
}

const CITIZEN = { full_name: 'Eval Runner', phone: '9000000000' };
const userId = randomUUID();
await repo.upsertProfile({ id: userId, ...CITIZEN });

const OUTCOME: Record<string, string> = { save_complaint: 'save', ask_user_clarification: 'clarify', reject_photo: 'reject', suggest_join_existing: 'duplicate' };

function checkDraft(k: EvalCase, subject: string | null, body: string | null, department: string | null, trusted: boolean) {
  if (!body || !subject) return ['no_draft'];
  const fails: string[] = [];
  const lc = `${subject}\n${body}`.toLowerCase();
  if (subject.length < 5 || subject.length > 100 || body.length < 50 || body.length > 1500) fails.push('length');
  if (/\[[^\]]{2,30}\]|<[A-Za-z ]{2,30}>|\{\{|\bX{3,}\b/.test(body)) fails.push('placeholder');
  if (/\*\*|^#{1,6}\s/m.test(body)) fails.push('markdown');
  const squash = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (trusted && department && !squash(body).includes(squash(department))) fails.push('department_not_named');
  if (!body.includes(CITIZEN.full_name) || !body.includes(CITIZEN.phone)) fails.push('citizen_details');
  const phones = body.match(/(?<!\d)[6-9]\d{9}(?!\d)/g) ?? [];
  if (phones.some((p) => p !== CITIZEN.phone)) fails.push('invented_phone');
  for (const w of k.expect.draft_must_mention ?? []) if (!lc.includes(w.toLowerCase())) fails.push(`missing:${w}`);
  for (const w of k.expect.draft_must_not_mention ?? []) if (lc.includes(w.toLowerCase())) fails.push(`leaked:${w}`);
  return fails;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: any[] = [];
const selected = cases.filter((k) => !only || only.includes(k.id));
console.log(`Evaluating ${selected.length} case(s) with ${modeLabel}\n`);

async function runCase(k: EvalCase) {
  const started = Date.now();
  if (k.gps?.geocode) primeGeocodeCache(k.gps.lat, k.gps.lng, k.gps.geocode);
  const id = randomUUID();
  const photoUrl = k.photo
    ? await savePhoto(userId, fs.readFileSync(path.join(root, 'photos', k.photo)), k.photo.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
    : null;
  const models = new Set<string>();
  let fellBack = false;
  const track = (r: { model: string; fellBackOffline: boolean }) => {
    models.add(r.model);
    fellBack ||= r.fellBackOffline;
  };

  let outcome = 'error';
  let predicted: string | null = null;
  let analysisMode: string | null = null;
  let department: string | null = null;
  let trusted = false;
  let subject: string | null = null;
  let body: string | null = null;
  let error: string | null = null;
  try {
    const intake = await runAgent(
      intakeAgent,
      { intakeId: id, userId, photoUrl, latitude: k.gps?.lat ?? null, longitude: k.gps?.lng ?? null, manualAddress: k.address, userNote: k.note, clarificationAnswer: null, autoSubmit: false, forceNew: true },
      { complaintId: id, userId },
    );
    track(intake);
    analysisMode = (intake.toolCalls.find((t) => t.toolName === 'analyze_photo')?.output as any)?.mode ?? 'vision';
    const terminal = [...intake.toolCalls].reverse().find((t) => OUTCOME[t.toolName] && !(t.output as any)?.error);
    outcome = terminal ? OUTCOME[terminal.toolName] : 'none';
    if (outcome === 'save') {
      predicted = (terminal!.input as any).issue_type;
      track(await runAgent(jurisdictionAgent, { complaint: (await repo.getComplaint(id))! }, { complaintId: id, userId }));
      const c = (await repo.getComplaint(id))!;
      const j = c.jurisdiction_portal_id ? await repo.getJurisdiction(c.jurisdiction_portal_id) : null;
      department = c.jurisdiction_department;
      trusted = j?.review_status === 'approved';
      track(await runAgent(draftingAgent, { complaintId: id }, { complaintId: id, userId }));
      const d = (await repo.getComplaint(id))!;
      subject = d.draft_subject;
      body = d.draft_text;
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const e = k.expect;
  const intakeOk = outcome === e.intake && (e.intake !== 'save' || predicted === e.issue_type);
  const scoreRouting = e.intake === 'save' && outcome === 'save';
  const expectedNone = e.department === null && !e.department_contains;
  const deptOk = !scoreRouting
    ? null
    : expectedNone
      ? !trusted
      : trusted && !!department && (e.department ? department === e.department : department.toLowerCase().includes(e.department_contains!.toLowerCase()));
  const misrouted = scoreRouting && trusted && deptOk === false;
  const draftFails = scoreRouting ? checkDraft(k, subject, body, department, trusted) : null;

  const r = {
    id: k.id,
    tags: k.tags ?? [],
    expected: { intake: e.intake, issue_type: e.issue_type ?? null, department: e.department ?? e.department_contains ?? null },
    got: { intake: outcome, issue_type: predicted, department, trusted, analysis_mode: analysisMode },
    intake_ok: intakeOk,
    department_ok: deptOk,
    misrouted,
    draft_ok: draftFails ? draftFails.length === 0 : null,
    draft_failures: draftFails,
    draft: body ? { subject, body } : null,
    models: [...models],
    fell_back_offline: fellBack,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    error,
  };
  return r;
}

/** Wait until the Gemini circuit breaker allows calls again (free tier: 15 requests/minute). */
async function waitForGemini() {
  while (useGemini && !geminiAvailable()) await sleep(5000);
}

for (const k of selected) {
  // A Gemini error inside a case means part of it silently ran on the offline planner, which would
  // make the "Gemini" score meaningless. Wait for the quota window and run the case again.
  let r: Awaited<ReturnType<typeof runCase>> & { gemini_errors?: number };
  for (let attempt = 1; ; attempt++) {
    await waitForGemini();
    const before = geminiErrorCount();
    r = await runCase(k);
    r.gemini_errors = geminiErrorCount() - before;
    if (!useGemini || (!r.gemini_errors && !r.fell_back_offline) || attempt === 4) break;
    console.log(`${k.id.padEnd(6)} hit a Gemini error/quota limit — waiting, then retrying (attempt ${attempt + 1}/4)`);
    await sleep(20000);
  }
  results.push(r);
  const e = k.expect;
  const { intake_ok: intakeOk, department_ok: deptOk, misrouted, draft_failures: draftFails, fell_back_offline: fellBack, error } = r;
  const predicted = r.got.issue_type;
  const outcome = r.got.intake;
  const mark = (b: boolean | null) => (b === null ? '·' : b ? '✅' : '❌');
  console.log(
    `${k.id.padEnd(6)} intake ${mark(intakeOk)} ${(e.intake === 'save' ? `${e.issue_type}` : e.intake).padEnd(13)} → ${(predicted ?? outcome).padEnd(13)}` +
      ` dept ${mark(deptOk)}${misrouted ? ' MISROUTED' : ''}  draft ${mark(r.draft_ok)}${draftFails?.length ? ` ${draftFails.join(',')}` : ''}` +
      `${fellBack || r.gemini_errors ? '  [Gemini error: partly offline]' : ''}${error ? `  ERROR ${error}` : ''}`,
  );
  if (delayMs) await sleep(delayMs);
}

const frac = (xs: any[], f: (x: any) => boolean) => (xs.length ? Number((xs.filter(f).length / xs.length).toFixed(3)) : null);
const expectSave = results.filter((r) => r.expected.intake === 'save');
const routed = results.filter((r) => r.department_ok !== null);
const drafted = results.filter((r) => r.draft_ok !== null);
const failureCounts: Record<string, number> = {};
for (const r of drafted) for (const f of r.draft_failures) failureCounts[f.replace(/:.*/, '')] = (failureCounts[f.replace(/:.*/, '')] ?? 0) + 1;

const summary = {
  mode: modeLabel,
  data: 'SYNTHETIC text cases (unreviewed expected answers)' + (results.some((r) => r.tags.includes('photo')) ? ' + labelled photos' : ''),
  run_at: new Date().toISOString(),
  cases: results.length,
  intake: {
    accuracy: frac(results, (r) => r.intake_ok),
    issue_type_accuracy: frac(expectSave, (r) => r.got.issue_type === r.expected.issue_type),
    clarify_recall: frac(results.filter((r) => r.expected.intake === 'clarify'), (r) => r.got.intake === 'clarify'),
    reject_recall: frac(results.filter((r) => r.expected.intake === 'reject'), (r) => r.got.intake === 'reject'),
    wrongly_rejected: results.filter((r) => r.expected.intake !== 'reject' && r.got.intake === 'reject').length,
  },
  jurisdiction: {
    accuracy: frac(routed, (r) => r.department_ok),
    scored_cases: routed.length,
    misroutes_to_trusted_office: results.filter((r) => r.misrouted).length,
  },
  drafting: {
    pass_rate: frac(drafted, (r) => r.draft_ok),
    scored_cases: drafted.length,
    failures_by_check: failureCounts,
  },
  // For a Gemini run these should be 0; anything else means some cases were partly scored offline.
  fell_back_offline: results.filter((r) => r.fell_back_offline || r.gemini_errors).length,
  errors: results.filter((r) => r.error).length,
  avg_seconds_per_case: Number((results.reduce((a, r) => a + r.seconds, 0) / (results.length || 1)).toFixed(1)),
};

fs.mkdirSync(path.join(root, 'results'), { recursive: true });
fs.writeFileSync(path.join(root, 'results', `${modeKey}.json`), JSON.stringify({ summary, results }, null, 2));
console.log('\n' + JSON.stringify(summary, null, 2));

let failed = false;
if (args.includes('--check')) {
  const t = JSON.parse(fs.readFileSync(path.join(root, 'thresholds.json'), 'utf8'))[modeKey];
  const checks: Array<[string, number | null, number, 'min' | 'max']> = [
    ['intake.accuracy', summary.intake.accuracy, t.intake_accuracy, 'min'],
    ['jurisdiction.accuracy', summary.jurisdiction.accuracy, t.jurisdiction_accuracy, 'min'],
    ['drafting.pass_rate', summary.drafting.pass_rate, t.drafting_pass_rate, 'min'],
    ['jurisdiction.misroutes_to_trusted_office', summary.jurisdiction.misroutes_to_trusted_office, t.max_misroutes, 'max'],
    ['errors', summary.errors, 0, 'max'],
  ];
  for (const [name, got, limit, kind] of checks) {
    const ok = got !== null && (kind === 'min' ? got >= limit : got <= limit);
    if (!ok) failed = true;
    console.log(`${ok ? '✅' : '❌'} ${name} = ${got} (${kind} ${limit})`);
  }
}

await shutdownTracing(); // waits for every batch; flushAsync alone can drop in-flight ones
if ('flush' in repo) (repo as { flush(): void }).flush();
process.exit(failed ? 1 : 0);
