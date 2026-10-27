import { AsyncLocalStorage } from 'node:async_hooks';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { LanguageModelV4, LanguageModelV4Middleware, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { Langfuse, type LangfuseSpanClient, type LangfuseTraceClient } from 'langfuse';
import { config } from '../config.js';

/**
 * Langfuse tracing. One trace per top-level agent run (sessionId = complaint id, so the whole
 * pipeline of a complaint groups together). Nested agent runs, tool calls and every model call —
 * including the ones made inside tools (photo analysis, drafting, web search) — become child
 * observations with timing, token usage and cost.
 *
 * Everything here is a no-op unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set.
 */

export const tracingEnabled = Boolean(config.langfusePublicKey && config.langfuseSecretKey);

const langfuse = tracingEnabled
  ? new Langfuse({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseBaseUrl,
      flushAt: 20,
      flushInterval: 5000,
    })
  : null;

type Parent = LangfuseTraceClient | LangfuseSpanClient;
const current = new AsyncLocalStorage<{ trace: LangfuseTraceClient; parent: Parent }>();

/** Run an agent inside its own trace, or as a child span when called from another agent. */
export async function traceAgentRun<T>(
  name: string,
  meta: { complaintId: string | null; userId: string | null; input: unknown },
  fn: () => Promise<T>,
  summarize: (r: T) => unknown = (r) => r,
): Promise<T> {
  if (!langfuse) return fn();
  const outer = current.getStore();
  const trace =
    outer?.trace ??
    langfuse.trace({
      name,
      sessionId: meta.complaintId ?? undefined,
      userId: meta.userId ?? undefined,
      input: meta.input,
      tags: [config.portalMode, config.nodeEnv],
    });
  const span = (outer?.parent ?? trace).span({ name: `agent:${name}`, input: meta.input });
  try {
    const r = await current.run({ trace, parent: span }, fn);
    const out = summarize(r);
    span.end({ output: out });
    if (!outer) trace.update({ output: out });
    return r;
  } catch (e) {
    span.end({ level: 'ERROR', statusMessage: (e as Error).message });
    if (!outer) trace.update({ output: { error: (e as Error).message } });
    throw e;
  }
}

/** Wrap one tool execution in a span. */
export async function traceTool<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
  const ctx = current.getStore();
  if (!ctx) return fn();
  const span = ctx.parent.span({ name: `tool:${name}`, input });
  try {
    const r = await current.run({ trace: ctx.trace, parent: span }, fn);
    const err = (r as { error?: unknown } | null)?.error;
    span.end({ output: r, ...(err ? { level: 'WARNING' as const, statusMessage: String(err) } : {}) });
    return r;
  } catch (e) {
    span.end({ level: 'ERROR', statusMessage: (e as Error).message });
    throw e;
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
    const startTime = new Date();
    const base = { name: `llm:${model.modelId}`, model: model.modelId, startTime, input: promptForTrace(params.prompt) };
    try {
      const r = await doGenerate();
      const input = r.usage.inputTokens.total ?? 0;
      const output = r.usage.outputTokens.total ?? 0;
      const cost = costUsd(model.modelId, input, output);
      ctx.parent.generation({
        ...base,
        endTime: new Date(),
        output: r.content,
        usageDetails: { input, output, total: input + output },
        ...(cost ? { costDetails: cost } : {}),
        metadata: { provider: model.provider, finishReason: r.finishReason.unified },
      });
      return r;
    } catch (e) {
      ctx.parent.generation({ ...base, endTime: new Date(), level: 'ERROR', statusMessage: (e as Error).message });
      throw e;
    }
  },
};

/** Every model the agents use goes through this, so each call shows up in the trace. */
export function traced<M extends LanguageModel>(model: M): M {
  if (!langfuse || typeof model === 'string') return model;
  return wrapLanguageModel({ model: model as LanguageModelV4, middleware }) as M;
}

/** Sends every queued trace and waits for in-flight batches (flushAsync alone can drop them). */
export async function shutdownTracing() {
  await langfuse?.shutdownAsync().catch(() => {});
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
  const ids = new Set<string>();
  const queries = [`userId=${encodeURIComponent(filters.userId)}`, ...filters.complaintIds.map((c) => `sessionId=${encodeURIComponent(c)}`)];
  for (const q of queries) {
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${base}/api/public/traces?${q}&limit=100&page=${page}`, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Langfuse list traces ${res.status}`);
      const { data } = (await res.json()) as { data: Array<{ id: string }> };
      for (const t of data) ids.add(t.id);
      if (data.length < 100) break;
    }
  }
  const all = [...ids];
  for (let i = 0; i < all.length; i += 100) {
    const res = await fetch(`${base}/api/public/traces`, { method: 'DELETE', headers, body: JSON.stringify({ traceIds: all.slice(i, i + 100) }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Langfuse delete traces ${res.status}`);
  }
  return all.length;
}
