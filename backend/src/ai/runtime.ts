import { google } from '@ai-sdk/google';
import { generateText, hasToolCall, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { config, useGemini } from '../config.js';
import { repo } from '../db/index.js';
import { createOfflineModel, type OfflinePolicy } from './offlineModel.js';

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
          output = await exec(input, opts);
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
  return google(config.geminiModel);
}

export async function runAgent<I>(
  def: AgentDefinition<I>,
  input: I,
  opts: { complaintId?: string | null; userId?: string | null } = {},
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
        stopWhen: [stepCountIs(def.maxSteps ?? 10), ...(def.stopOnTools ?? []).map((t) => hasToolCall(t))],
        temperature: 0.2,
        maxRetries: 2,
      });
      return { text: res.text, toolCalls: record, complaintId: ctx.complaintId, model: label, fellBackOffline: fellBack };
    } catch (e) {
      (e as any).__toolCallsMade = record.length;
      throw e;
    }
  };

  const offline = () => attempt(createOfflineModel(def.name, def.offlinePolicy), 'offline-planner', !!useGemini);

  if (!useGemini) return offline();
  try {
    return await attempt(geminiModel(), config.geminiModel, false);
  } catch (e) {
    const made = (e as any).__toolCallsMade ?? 0;
    await repo.addToolLog({
      agent_name: def.name,
      complaint_id: ctx.complaintId,
      tool_name: '__model_error',
      arguments: null,
      result: null,
      duration_ms: null,
      error: (e as Error).message,
    });
    // Only fall back if no side-effecting tool ran yet; otherwise surface the error.
    if (made === 0) return offline();
    throw e;
  }
}

/** Single-shot structured/vision helper used *inside* tools (e.g. analyze_photo). */
export function visionModel(): LanguageModel | null {
  return useGemini ? google(config.geminiVisionModel) : null;
}

export function textModel(): LanguageModel | null {
  return useGemini ? google(config.geminiModel) : null;
}
