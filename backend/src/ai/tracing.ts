import { AsyncLocalStorage } from 'node:async_hooks';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { LanguageModelV4, LanguageModelV4Middleware, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseOtelSpanAttributes, setLangfuseTracerProvider, startObservation, type LangfuseAgent, type LangfuseTool } from '@langfuse/tracing';
import { config } from '../config.js';

/**
 * Langfuse tracing (OpenTelemetry). One trace per top-level agent run (sessionId = complaint id, so
 * the whole pipeline of a complaint groups together). Nested agent runs, tool calls and every model
 * call — including the ones made inside tools (photo analysis, drafting, web search) — become child
 * observations with timing, token usage and cost.
 *
 * Everything here is a no-op unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set.
 */

export const tracingEnabled = Boolean(config.langfusePublicKey && config.langfuseSecretKey);

// A private provider (not registered globally), so nothing else in the process gets traced by accident.
const provider = tracingEnabled
  ? new NodeTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: config.langfusePublicKey,
          secretKey: config.langfuseSecretKey,
          baseUrl: config.langfuseBaseUrl,
          environment: config.nodeEnv,
          flushAt: 20,
          flushInterval: 5,
        }),
      ],
    })
  : null;
if (provider) setLangfuseTracerProvider(provider);

/** The open observation that new children attach to, plus the trace-level attributes they carry. */
const current = new AsyncLocalStorage<{ parent: LangfuseAgent | LangfuseTool; traceAttrs: Record<string, string | string[]> }>();

function child<T extends 'agent' | 'tool'>(name: string, asType: T, input: unknown): T extends 'agent' ? LangfuseAgent : LangfuseTool {
  const ctx = current.getStore()!;
  const obs = asType === 'agent' ? ctx.parent.startObservation(name, { input }, { asType: 'agent' }) : ctx.parent.startObservation(name, { input }, { asType: 'tool' });
  obs.otelSpan.setAttributes(ctx.traceAttrs);
  return obs as T extends 'agent' ? LangfuseAgent : LangfuseTool;
}

/** Run an agent inside its own trace, or as a child span when called from another agent. */
export async function traceAgentRun<T>(
  name: string,
  meta: { complaintId: string | null; userId: string | null; input: unknown },
  fn: () => Promise<T>,
  summarize: (r: T) => unknown = (r) => r,
): Promise<T> {
  if (!provider) return fn();
  const outer = current.getStore();
  let span: LangfuseAgent;
  let traceAttrs: Record<string, string | string[]>;
  if (outer) {
    traceAttrs = outer.traceAttrs;
    span = child(`agent:${name}`, 'agent', meta.input);
  } else {
    traceAttrs = {
      [LangfuseOtelSpanAttributes.TRACE_NAME]: name,
      [LangfuseOtelSpanAttributes.TRACE_TAGS]: [config.portalMode, config.nodeEnv],
      ...(meta.complaintId ? { [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: meta.complaintId } : {}),
      ...(meta.userId ? { [LangfuseOtelSpanAttributes.TRACE_USER_ID]: meta.userId } : {}),
    };
    span = startObservation(`agent:${name}`, { input: meta.input }, { asType: 'agent' });
    span.otelSpan.setAttributes(traceAttrs);
    span.setTraceIO({ input: meta.input });
  }
  try {
    const r = await current.run({ parent: span, traceAttrs }, fn);
    const out = summarize(r);
    span.update({ output: out });
    if (!outer) span.setTraceIO({ output: out });
    return r;
  } catch (e) {
    span.update({ level: 'ERROR', statusMessage: (e as Error).message });
    if (!outer) span.setTraceIO({ output: { error: (e as Error).message } });
    throw e;
  } finally {
    span.end();
  }
}

/** Wrap one tool execution in a span. */
export async function traceTool<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const ctx = current.getStore();
  if (!ctx) return fn();
  const span = child(`tool:${name}`, 'tool', input);
  try {
    const r = await current.run({ ...ctx, parent: span }, fn);
    const err = (r as { error?: unknown } | null)?.error;
    span.update({ output: r, ...(err ? { level: 'WARNING' as const, statusMessage: String(err) } : {}) });
    return r;
  } catch (e) {
    span.update({ level: 'ERROR', statusMessage: (e as Error).message });
    throw e;
  } finally {
    span.end();
  }
}

/** Images and audio would bloat traces — keep the text, replace binary parts with a marker. */
function promptForTrace(prompt: LanguageModelV4Prompt) {
  return prompt.map((m) =>
    typeof m.content === 'string'
      ? m
      : { ...m, content: m.content.map((p) => (p.type === 'file' ? { type: 'file', mediaType: p.mediaType, data: '[binary omitted]' } : p)) },
  );
}

export function costUsd(modelId: string, inputTokens: number, outputTokens: number) {
  const p = config.modelPrices[modelId];
  if (!p) return null;
  const input = (inputTokens / 1e6) * p.input;
  const output = (outputTokens / 1e6) * p.output;
  return { input, output, total: input + output };
}

const middleware: LanguageModelV4Middleware = {
  specificationVersion: 'v4',
  async wrapGenerate({ doGenerate, params, model }) {
    const ctx = current.getStore();
    if (!ctx) return doGenerate();
    const gen = ctx.parent.startObservation(`llm:${model.modelId}`, { model: model.modelId, input: promptForTrace(params.prompt) }, { asType: 'generation' });
    gen.otelSpan.setAttributes(ctx.traceAttrs);
    try {
      const r = await doGenerate();
      const input = r.usage.inputTokens.total ?? 0;
      const output = r.usage.outputTokens.total ?? 0;
      const cost = costUsd(model.modelId, input, output);
      gen.update({
        output: r.content,
        usageDetails: { input, output, total: input + output },
        ...(cost ? { costDetails: cost } : {}),
        metadata: { provider: model.provider, finishReason: r.finishReason.unified },
      });
      return r;
    } catch (e) {
      gen.update({ level: 'ERROR', statusMessage: (e as Error).message });
      throw e;
    } finally {
      gen.end();
    }
  },
};

/** Every model the agents use goes through this, so each call shows up in the trace. */
export function traced<M extends LanguageModel>(model: M): M {
  if (!provider || typeof model === 'string') return model;
  return wrapLanguageModel({ model: model as LanguageModelV4, middleware }) as M;
}

/** Sends every queued trace (call before the process exits). */
export async function shutdownTracing() {
  await provider?.shutdown().catch(() => {});
}
/**
 * Deletes a user's traces from Langfuse (account deletion): traces tagged with their user id and
 * every trace grouped under one of their complaints. Best effort: returns how many were deleted.
 */
export async function deleteTraces(filters: { userId: string; complaintIds: string[] }) {
  if (!tracingEnabled) return 0;
  const base = config.langfuseBaseUrl.replace(/\/$/, '');
  const headers = {
    Authorization: `Basic ${Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
  // Langfuse's v2 API lists observations (not traces) and needs a time range; collect their trace ids.
  const ids = new Set<string>();
  const range = `fromStartTime=2026-01-01T00:00:00Z&toStartTime=${new Date(Date.now() + 60_000).toISOString()}`;
  const queries = [`userId=${encodeURIComponent(filters.userId)}`, ...filters.complaintIds.map((c) => `sessionId=${encodeURIComponent(c)}`)];
  for (const q of queries) {
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const url = `${base}/api/public/v2/observations?${q}&${range}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Langfuse list observations ${res.status}`);
      const { data, meta } = (await res.json()) as { data: Array<{ traceId: string }>; meta?: { cursor?: string | null } };
      for (const o of data) ids.add(o.traceId);
      cursor = meta?.cursor ?? null;
      if (!cursor) break;
    }
  }
  const all = [...ids];
  for (let i = 0; i < all.length; i += 100) {
    const res = await fetch(`${base}/api/public/traces`, { method: 'DELETE', headers, body: JSON.stringify({ traceIds: all.slice(i, i + 100) }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Langfuse delete traces ${res.status}`);
  }
  return all.length;
}
