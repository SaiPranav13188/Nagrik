/**
 * Proves the Langfuse wiring without a Langfuse account: points the SDK at a local fake OpenTelemetry
 * endpoint (the one Langfuse ingests traces on), runs the Intake → Jurisdiction → Drafting agents (offline planner), and checks that a
 * trace with agent spans, tool spans and model-call generations (with token usage) arrives.
 *
 *   npm run test:tracing
 */
import { TEST_PORT } from './test-env.js';
import express from 'express';

const INGEST_PORT = TEST_PORT + 5;
Object.assign(process.env, { LANGFUSE_PUBLIC_KEY: 'pk-lf-test', LANGFUSE_SECRET_KEY: 'sk-lf-test', LANGFUSE_BASE_URL: `http://127.0.0.1:${INGEST_PORT}` });

/** One exported (finished) span with its attributes flattened. */
interface Span { name: string; traceId: string; spanId: string; parentSpanId?: string; start: number; end: number; attrs: Record<string, any> }
const spans: Span[] = [];
const value = (v: any): any => v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue ?? v?.arrayValue?.values?.map(value);
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const ingest = express();
ingest.use(express.json({ limit: '10mb' }));
ingest.post('/api/public/otel/v1/traces', (req, res) => {
  for (const rs of req.body.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? [])
      for (const sp of ss.spans ?? [])
        spans.push({
          name: sp.name,
          traceId: sp.traceId,
          spanId: sp.spanId,
          parentSpanId: sp.parentSpanId || undefined,
          start: Number(sp.startTimeUnixNano),
          end: Number(sp.endTimeUnixNano),
          attrs: Object.fromEntries((sp.attributes ?? []).map((a: any) => [a.key, value(a.value)])),
        });
  res.json({});
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

  const type = (s: Span) => s.attrs['langfuse.observation.type'];
  const roots = spans.filter((s) => !s.parentSpanId);
  const names = spans.map((s) => s.name);
  const gens = spans.filter((s) => type(s) === 'generation');
  check('one trace per top-level agent run, grouped by complaint (sessionId)', roots.length === 2 && new Set(roots.map((r) => r.traceId)).size === 2 && roots.every((r) => r.attrs['session.id'] === id && r.attrs['user.id'] === userId), roots.map((r) => r.attrs));
  check('agent spans recorded', names.includes('agent:intake_agent') && names.includes('agent:jurisdiction_agent') && roots.every((r) => type(r) === 'agent'), names);
  check('every tool call is a span', ['tool:analyze_photo', 'tool:save_complaint', 'tool:lookup_jurisdiction', 'tool:assign_jurisdiction'].every((n) => spans.some((s) => s.name === n && type(s) === 'tool')), names);
  check('tool spans sit inside their agent trace', spans.filter((s) => type(s) === 'tool').every((s) => !!s.parentSpanId && roots.some((r) => r.traceId === s.traceId)));
  check('model calls recorded as generations with token usage', gens.length >= 4 && gens.every((g) => typeof json(g.attrs['langfuse.observation.usage_details'])?.input === 'number'), gens[0]?.attrs);
  check('generations carry model name and timing', gens.every((g) => g.attrs['langfuse.observation.model.name'] && g.end > g.start), gens[0]);
  check('spans are closed with output (duration measurable)', spans.filter((s) => type(s) !== 'generation').every((s) => s.end >= s.start && s.attrs['langfuse.observation.output'] !== undefined), spans.find((s) => s.attrs['langfuse.observation.output'] === undefined));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  ingestServer.close();
  console.log(failures ? `\n${failures} tracing check(s) failed` : '\nAll tracing checks passed');
  process.exit(failures ? 1 : 0);
}
