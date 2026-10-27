import { google } from '@ai-sdk/google';
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { config, useGemini } from '../config.js';
import { repo } from '../db/index.js';
import { createOfflineModel, type OfflinePolicy } from './offlineModel.js';
import { traceAgentRun, traceTool, traced } from './tracing.js';

export interface AgentContext {
  agentName: string;
  complaintId: string | null;
  userId: string | null;
  /** Updated by tools that create the complaint mid-run (Intake Agent). */
  setComplaintId(id: string): void;
}

export interface AgentDefinition<I> {
  name: string;
  system: string;
  buildTools(ctx: AgentContext, input: I): ToolSet;
  buildPrompt(input: I): string | ModelMessage[];
  offlinePolicy: OfflinePolicy;
  maxSteps?: number;
  /** Tools that end the loop as soon as they are called (terminal decisions). */
  stopOnTools?: string[];
}

export interface AgentRunResult {
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown; output: unknown }>;
  complaintId: string | null;
  model: string;
  fellBackOffline: boolean;
}

const MAX_LOG_CHARS = 8000;
function compact(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v, (_k, val) => (typeof val === 'string' && val.length > 2000 ? val.slice(0, 2000) + '…[truncated]' : val));
    return s.length > MAX_LOG_CHARS ? { truncated: true, preview: s.slice(0, MAX_LOG_CHARS) } : JSON.parse(s);
  } catch {
    return { unserializable: String(v) };
  }
}

/**
 * Guardrail: every tool call on every agent is written to agent_tool_logs — arguments, result,
 * duration and error — before the result is returned to the model.
 */
function withToolLogging(tools: ToolSet, ctx: AgentContext, record: AgentRunResult['toolCalls']): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const exec = (t as any).execute as ((input: unknown, opts: unknown) => Promise<unknown>) | undefined;
    if (!exec) {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const started = Date.now();
        let output: unknown;
        let error: string | null = null;
        try {
          output = await traceTool(name, input, () => exec(input, opts));
          return output;
        } catch (e) {
          error = (e as Error).message;
          // Return the error to the model as data so it can decide what to do next.
          output = { error };
          return output;
        } finally {
          record.push({ toolName: name, input, output });
          await repo.addToolLog({
            agent_name: ctx.agentName,
            complaint_id: ctx.complaintId,
            tool_name: name,
            arguments: compact(input),
            result: compact(output),
            duration_ms: Date.now() - started,
            error,
          });
        }
      },
    } as any;
  }
  return wrapped;
}

function geminiModel(): LanguageModel {
  return traced(google(config.geminiModel));
}

// ───────────── Gemini circuit breaker ─────────────
// When Google rejects calls for quota/rate limits, stop calling it for a while and let every
// agent run on the offline planner instead of failing (free tier limits are low).
// Paused per model: Google's quotas are per model, so the vision model running out
// shouldn't stop the reasoning model (and vice versa).
const pausedUntil = new Map<string, number>();
const streaks = new Map<string, number>();

export function isQuotaError(e: unknown) {
  const m = String((e as Error)?.message ?? e);
  return /quota|rate.?limit|RESOURCE_EXHAUSTED|429|exceeded/i.test(m);
}

let geminiErrors = 0;
/** Total Gemini failures so far (the eval uses it to spot runs that silently fell back offline). */
export const geminiErrorCount = () => geminiErrors;

export function noteGeminiError(e: unknown, model: string = config.geminiModel) {
  geminiErrors++;
  if (!isQuotaError(e)) return;
  const m = String((e as Error)?.message ?? e);
  const retry = Number(m.match(/retry in ([\d.]+)s/i)?.[1] ?? 60);
  const streak = Math.min((streaks.get(model) ?? 0) + 1, 6);
  streaks.set(model, streak);
  const pauseMs = Math.min(Math.max(retry, 60) * 1000 * 2 ** (streak - 1), 30 * 60 * 1000);
  pausedUntil.set(model, Date.now() + pauseMs);
  console.warn(`[gemini] ${model} quota/rate limit hit — offline fallback for ${Math.round(pauseMs / 1000)}s`);
}

export function geminiAvailable(model: string = config.geminiModel) {
  return useGemini && Date.now() >= (pausedUntil.get(model) ?? 0);
}

function noteGeminiSuccess(model: string = config.geminiModel) {
  streaks.set(model, 0);
}

/** Tools with no side effects: re-running them on the offline planner after a Gemini failure is safe. */
const READ_ONLY_TOOLS = new Set([
  'analyze_photo',
  'reverse_geocode',
  'lookup_jurisdiction',
  'web_search',
  'get_complaint_context',
  'draft_complaint_text',
  'get_form_selectors',
  'detect_captcha',
  'get_complaint_timeline',
  'list_submitted_complaints_needing_check',
]);

export function runAgent<I>(
  def: AgentDefinition<I>,
  input: I,
  opts: { complaintId?: string | null; userId?: string | null } = {},
): Promise<AgentRunResult> {
  return traceAgentRun(
    def.name,
    { complaintId: opts.complaintId ?? null, userId: opts.userId ?? null, input: compact(input) },
    () => runAgentUntraced(def, input, opts),
    (r) => ({ model: r.model, fellBackOffline: r.fellBackOffline, tools: r.toolCalls.map((t) => t.toolName), text: r.text }),
  );
}

async function runAgentUntraced<I>(
  def: AgentDefinition<I>,
  input: I,
  opts: { complaintId?: string | null; userId?: string | null },
): Promise<AgentRunResult> {
  const ctx: AgentContext = {
    agentName: def.name,
    complaintId: opts.complaintId ?? null,
    userId: opts.userId ?? null,
    setComplaintId(id) {
      this.complaintId = id;
    },
  };

  const attempt = async (model: LanguageModel, label: string, fellBack: boolean): Promise<AgentRunResult> => {
    const record: AgentRunResult['toolCalls'] = [];
    const tools = withToolLogging(def.buildTools(ctx, input), ctx, record);
    const prompt = def.buildPrompt(input);
    try {
      const res = await generateText({
        model,
        system: def.system,
        ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
        tools,
        // A terminal tool that a guardrail refused doesn't end the run: the agent gets the refusal and picks a safe path.
        stopWhen: [stepCountIs(def.maxSteps ?? 10), () => record.some((r) => def.stopOnTools?.includes(r.toolName) && !(r.output as { error?: unknown } | null)?.error)],
        temperature: 0.2,
        maxRetries: 1,
      });
      return { text: res.text, toolCalls: record, complaintId: ctx.complaintId, model: label, fellBackOffline: fellBack };
    } catch (e) {
      (e as any).__toolCalls = record.map((r) => r.toolName);
      throw e;
    }
  };

  const offline = () => attempt(traced(createOfflineModel(def.name, def.offlinePolicy)), 'offline-planner', !!useGemini);

  if (!geminiAvailable()) return offline();
  try {
    const r = await attempt(geminiModel(), config.geminiModel, false);
    noteGeminiSuccess();
    return r;
  } catch (e) {
    noteGeminiError(e);
    const done: string[] = (e as any).__toolCalls ?? [];
    await repo.addToolLog({
      agent_name: def.name,
      complaint_id: ctx.complaintId,
      tool_name: '__model_error',
      arguments: null,
      result: null,
      duration_ms: null,
      error: (e as Error).message,
    });
    // Fall back to the offline planner unless a side-effecting tool already ran (then the
    // offline rerun could duplicate work) — in that case surface the error.
    if (done.every((t) => READ_ONLY_TOOLS.has(t))) return offline();
    throw e;
  }
}

/** Single-shot structured/vision helper used *inside* tools (e.g. analyze_photo). */
export function visionModel(): LanguageModel | null {
  return geminiAvailable(config.geminiVisionModel) ? traced(google(config.geminiVisionModel)) : null;
}

export function textModel(): LanguageModel | null {
  return geminiAvailable() ? traced(google(config.geminiModel)) : null;
}
