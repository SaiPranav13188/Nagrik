/**
 * Evaluation harness for the Intake + Jurisdiction agents (spec: "10–15 real photos from your area,
 * verified against the actual published department responsible for each issue type").
 *
 * 1. Put photos in eval/photos/ and describe them in eval/labels.csv:
 *      file,expected_issue_type,expected_department_contains,lat,lng,note
 *      pothole-bus-stand.jpg,pothole,Engineering Section (Roads),16.3623,78.0622,
 * 2. Run with a throwaway data dir so eval complaints don't mix with real ones:
 *      LOCAL_DATA_DIR=.data-eval GEMINI_API_KEY=... npm run eval:intake
 *
 * Prints per-photo results and overall accuracy, and writes eval/results.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../src/ai/runtime.js';
import { intakeAgent } from '../src/agents/intake.js';
import { jurisdictionAgent } from '../src/agents/jurisdiction.js';
import { repo } from '../src/db/index.js';
import { savePhoto } from '../src/services/storage.js';
import { useGemini } from '../src/config.js';
import type { IssueType } from '../src/db/types.js';

const root = path.resolve('eval');
const csv = path.join(root, 'labels.csv');
if (!fs.existsSync(csv)) {
  fs.mkdirSync(path.join(root, 'photos'), { recursive: true });
  fs.writeFileSync(csv, 'file,expected_issue_type,expected_department_contains,lat,lng,note\n');
  console.log(`Created ${csv}. Add your labelled photos to eval/photos/ and rows to labels.csv, then re-run.`);
  process.exit(0);
}
if (!useGemini) console.warn('⚠️  No GEMINI_API_KEY — photos will not actually be analyzed (offline planner). Results will be meaningless.\n');

const rows = fs
  .readFileSync(csv, 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .filter(Boolean)
  .map((l) => {
    const [file, issue, dept, lat, lng, note] = l.split(',').map((s) => s.trim());
    return { file, issue: issue as IssueType, dept, lat: Number(lat), lng: Number(lng), note: note || null };
  });

const userId = randomUUID();
await repo.upsertProfile({ id: userId, full_name: 'Eval Runner', phone: '9000000000' });

const results: any[] = [];
for (const r of rows) {
  const bytes = fs.readFileSync(path.join(root, 'photos', r.file));
  const mime = r.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const photoUrl = await savePhoto(userId, bytes, mime);
  const intakeId = randomUUID();
  const intake = await runAgent(
    intakeAgent,
    { intakeId, userId, photoUrl, latitude: r.lat, longitude: r.lng, manualAddress: null, userNote: r.note, clarificationAnswer: null, autoSubmit: false },
    { complaintId: intakeId, userId },
  );
  const terminal = [...intake.toolCalls].reverse().find((t) => ['save_complaint', 'ask_user_clarification', 'reject_photo'].includes(t.toolName));
  const analysis = intake.toolCalls.find((t) => t.toolName === 'analyze_photo')?.output as any;
  let predicted: string | null = null;
  let department: string | null = null;
  if (terminal?.toolName === 'save_complaint') {
    predicted = (terminal.input as any).issue_type;
    const c = (await repo.getComplaint(intakeId))!;
    await runAgent(jurisdictionAgent, { complaint: c }, { complaintId: c.id, userId });
    department = (await repo.getComplaint(intakeId))?.jurisdiction_department ?? null;
  }
  const res = {
    file: r.file,
    expected: r.issue,
    predicted,
    outcome: terminal?.toolName ?? 'none',
    confidence: analysis?.confidence ?? null,
    alternative: analysis?.alternative_issue_type ?? null,
    classification_correct: predicted === r.issue,
    department,
    department_correct: !!department && !!r.dept && department.toLowerCase().includes(r.dept.toLowerCase()),
  };
  results.push(res);
  console.log(
    `${res.classification_correct ? '✅' : res.outcome === 'ask_user_clarification' ? '❓' : '❌'} ${r.file}: expected ${r.issue}, got ${predicted ?? res.outcome}` +
      ` (conf ${res.confidence ?? '—'})  dept: ${department ?? '—'} ${res.department_correct ? '✅' : ''}`,
  );
}

const n = results.length || 1;
const decided = results.filter((r) => r.outcome === 'save_complaint');
const summary = {
  photos: results.length,
  classification_accuracy: results.filter((r) => r.classification_correct).length / n,
  accuracy_when_decided: decided.length ? decided.filter((r) => r.classification_correct).length / decided.length : null,
  clarification_rate: results.filter((r) => r.outcome === 'ask_user_clarification').length / n,
  rejection_rate: results.filter((r) => r.outcome === 'reject_photo').length / n,
  department_accuracy: results.filter((r) => r.department_correct).length / n,
};
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ summary, results }, null, 2));
console.log('\n', summary);
if ('flush' in repo) (repo as any).flush();
process.exit(0);
