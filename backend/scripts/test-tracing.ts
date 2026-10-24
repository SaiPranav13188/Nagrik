/**
 * Proves the Langfuse wiring without a Langfuse account: points the SDK at a local fake ingestion
 * endpoint, runs the Intake → Jurisdiction → Drafting agents (offline planner), and checks that a
 * trace with agent spans, tool spans and model-call generations (with token usage) arrives.
 *
 *   npm run test:tracing
 */
import { TEST_PORT } from './test-env.js';
import express from 'express';

const INGEST_PORT = TEST_PORT + 5;
Object.assign(process.env, { LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test', LANGFUSE_BASE_URL: `http://127.0.0.1:${INGEST_PORT}` });

const events: Array<{ type: string; body: any }> = [];
const ingest = express();
ingest.use(express.json({ limit: '10mb' }));
ingest.post('/api/public/ingestion', (req, res) => {
  events.push(...(req.body.batch ?? []));
  res.status(207).json({ successes: (req.body.batch ?? []).map((e: any) => ({ id: e.id, status: 201 })), errors: [] });
});
const ingestServer = ingest.listen(INGEST_PORT);

// Imported after the env is set: tracing reads its keys at import time.
const { runAgent } = await import('../src/ai/runtime.js');
const { shutdownTracing, tracingEnabled } = await import('../src/ai/tracing.js');
const { intakeAgent } = await import('../src/agents/intake.js');
const { jurisdictionAgent } = await import('../src/agents/jurisdiction.js');
const { repo } = await import('../src/db/index.js');
const { randomUUID } = await import('node:crypto');

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`, !ok && detail !== undefined ? JSON.stringify(detail).slice(0, 400) : '');
  if (!ok) failures++;
};

try {
  check('tracing is enabled when both keys are set', tracingEnabled);
  const userId = randomUUID();
  const id = randomUUID();
  await repo.upsertProfile({ id: userId, full_name: 'Trace Tester', phone: '9876543210' });
  await runAgent(
    intakeAgent,
    { intakeId: id, userId, photoUrl: null, latitude: null, longitude: null, manualAddress: 'Bus stand, Wanaparthy', userNote: 'big pothole near bus stand', clarificationAnswer: null, autoSubmit: false, forceNew: true },
    { complaintId: id, userId },
  );
  await runAgent(jurisdictionAgent, { complaint: (await repo.getComplaint(id))! }, { complaintId: id, userId });
  await shutdownTracing();

  const traces = events.filter((e) => e.type === 'trace-create');
  const spans = events.filter((e) => e.type === 'span-create').map((e) => e.body.name as string);
  const gens = events.filter((e) => e.type === 'generation-create');
  check('one trace per top-level agent run, grouped by complaint (sessionId)', traces.length >= 2 && traces.every((t) => !t.body.sessionId || t.body.sessionId === id), traces.map((t) => t.body));
  check('agent spans recorded', spans.includes('agent:intake_agent') && spans.includes('agent:jurisdiction_agent'), spans);
  check('every tool call is a span', ['tool:analyze_photo', 'tool:save_complaint', 'tool:lookup_jurisdiction', 'tool:assign_jurisdiction'].every((s) => spans.includes(s)), spans);
  check('model calls recorded as generations with token usage', gens.length >= 4 && gens.every((g) => g.body.usageDetails && typeof g.body.usageDetails.input === 'number'), gens[0]?.body);
  check('generations carry model name and timing', gens.every((g) => g.body.model && g.body.startTime && g.body.endTime), gens[0]?.body);
  const ends = events.filter((e) => e.type === 'span-update');
  check('spans are closed with output (duration measurable)', ends.length >= spans.length, { creates: spans.length, updates: ends.length });
} catch (e) {
  console.error(e);
  failures++;
} finally {
  ingestServer.close();
  console.log(failures ? `\n${failures} tracing check(s) failed` : '\nAll tracing checks passed');
  process.exit(failures ? 1 : 0);
}
