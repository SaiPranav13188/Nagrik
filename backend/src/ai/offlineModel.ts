import { randomUUID } from 'node:crypto';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content } from '@ai-sdk/provider';

export interface HistoryItem {
  toolName: string;
  input: any;
  output: any;
}

export interface PolicyState {
  system: string;
  userText: string;
  history: HistoryItem[];
  /** Most recent result for a given tool, if called. */
  last(toolName: string): HistoryItem | undefined;
  called(toolName: string): boolean;
}

export type PolicyDecision = { tool: string; input: Record<string, unknown> } | { text: string };
export type OfflinePolicy = (s: PolicyState) => PolicyDecision;

/**
 * A deterministic stand-in for the LLM used when no GEMINI key is configured.
 *
 * It implements the real LanguageModelV4 interface, so the *exact same* agent code path runs:
 * generateText → tool call → logged tool execution → tool result fed back → next decision.
 * Only the decision-maker differs — a rule-based policy per agent instead of Gemini. This keeps
 * the whole pipeline testable offline and in CI, and is also the automatic fallback if Gemini
 * is unreachable.
 */
export function createOfflineModel(agentName: string, policy: OfflinePolicy): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'nagrik-offline',
    modelId: `offline-planner:${agentName}`,
    supportedUrls: {},
    async doGenerate(options: LanguageModelV4CallOptions) {
      const calls = new Map<string, { toolName: string; input: unknown }>();
      const history: HistoryItem[] = [];
      let system = '';
      let userText = '';
      for (const m of options.prompt) {
        if (m.role === 'system') system += m.content;
        else if (m.role === 'user') {
          for (const p of m.content) if (p.type === 'text') userText += p.text + '\n';
        } else if (m.role === 'assistant') {
          for (const p of m.content) if (p.type === 'tool-call') calls.set(p.toolCallId, { toolName: p.toolName, input: p.input });
        } else if (m.role === 'tool') {
          for (const p of m.content) {
            if (p.type !== 'tool-result') continue;
            const call = calls.get(p.toolCallId);
            const o = p.output as { type: string; value?: unknown };
            const value = o.type === 'json' || o.type === 'text' ? o.value : { error: o.value ?? o.type };
            history.push({ toolName: p.toolName, input: call?.input, output: value });
          }
        }
      }
      const state: PolicyState = {
        system,
        userText,
        history,
        last: (n) => [...history].reverse().find((h) => h.toolName === n),
        called: (n) => history.some((h) => h.toolName === n),
      };
      const decision = policy(state);
      const content: LanguageModelV4Content[] =
        'tool' in decision
          ? [{ type: 'tool-call', toolCallId: randomUUID(), toolName: decision.tool, input: JSON.stringify(decision.input) }]
          : [{ type: 'text', text: decision.text }];
      return {
        content,
        finishReason: { unified: 'tool' in decision ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error('Offline planner does not support streaming');
    },
  };
}
