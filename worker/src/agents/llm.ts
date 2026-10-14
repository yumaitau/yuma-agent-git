import type { Env } from '../env';
import { z } from 'zod';
import { toolRegistry } from './tools';
import type { TranscriptEntry } from './runtime';
import type { TaskBudget } from './budget';
import { remaining } from './budget';
import { SYSTEM_PROMPT } from './prompt';

/**
 * Workers AI gateway (issue #19) — the model behind think-act-observe.
 *
 * Provider seam: production runs `env.AI.run('@cf/meta/llama-3.3-70b-…')`
 * (configurable via `AGENT_MODEL`); tests inject a scripted provider. The
 * response is **normalized** regardless of provider quirks: OpenAI-style
 * `tool_calls` first, then a text-fenced JSON fallback
 * (\`\`\`json {"tool": …}\`\`\`) — llama-class models emit the fence when
 * function-calling support is uneven, so both are accepted (documented
 * fallback).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  content?: string;
  tool_calls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface ChatInput {
  messages: ChatMessage[];
  tools?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export type ChatProvider = (env: Env, input: ChatInput) => Promise<ChatResult>;

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const responseSchema = z.object({
  response: z.unknown().optional(),
  result: z.unknown().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

/** Normalize any provider response into {content, tool_calls, usage}. */
export function normalizeChatResponse(raw: unknown): ChatResult {
  const parsed = responseSchema.safeParse(raw);
  const payload = parsed.success ? parsed.data : (raw as Record<string, unknown>);
  const body = (payload.response ?? payload.result ?? payload) as Record<string, unknown>;

  // OpenAI-style tool_calls
  const calls: ToolCall[] = [];
  const rawCalls = (body.tool_calls ?? body.toolCalls) as
    | {
        function?: { name?: string; arguments?: unknown };
        name?: string;
        arguments?: unknown;
      }[]
    | undefined;
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      const name = call.function?.name ?? call.name;
      const args = call.function?.arguments ?? call.arguments;
      if (!name) continue;
      calls.push({
        name,
        arguments:
          typeof args === 'string'
            ? ((safeJson(args) as Record<string, unknown> | null) ?? {})
            : ((args as Record<string, unknown> | undefined) ?? {}),
      });
    }
  }

  const content =
    typeof body.content === 'string'
      ? body.content
      : typeof body === 'string'
        ? body
        : undefined;
  const text = typeof body.response === 'string' ? body.response : content;

  // text-fenced JSON fallback: ```json {"tool": …}```
  if (calls.length === 0 && typeof text === 'string') {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const candidate = fence
      ? (fence[1] as string)
      : text.trim().startsWith('{')
        ? text
        : null;
    if (candidate) {
      const parsedFence = safeJson(candidate);
      if (parsedFence && typeof parsedFence === 'object') {
        const obj = parsedFence as {
          tool?: string;
          name?: string;
          arguments?: unknown;
          args?: unknown;
        };
        const name = obj.tool ?? obj.name;
        if (typeof name === 'string') {
          calls.push({
            name,
            arguments: (obj.arguments ?? obj.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }
  }

  return {
    content: text,
    tool_calls: calls,
    usage: (body.usage as ChatResult['usage']) ?? (payload.usage as ChatResult['usage']),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const defaultProvider: ChatProvider = async (env, input) => {
  if (!env.AI) {
    // binding lives in the `prod` wrangler env (see wrangler.jsonc) — without
    // it the loop fails the task with a clear reason instead of hanging
    throw new Error(
      'ai_not_configured: Workers AI binding missing (deploy with --env prod)',
    );
  }
  const model = env.AGENT_MODEL ?? DEFAULT_MODEL;
  // retry once on 5xx/429 with jittered backoff
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return normalizeChatResponse(
        await env.AI.run(model, {
          messages: input.messages,
          tools: input.tools ? toolSchemas() : undefined,
          max_tokens: input.max_tokens ?? 2048,
          temperature: input.temperature ?? 0.2,
        } as never),
      );
    } catch (err) {
      const retryable = /5\d\d|429|rate.?limit/i.test(String(err));
      if (attempt === 0 && retryable) {
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
        continue;
      }
      throw err;
    }
  }
  throw new Error('ai gateway exhausted');
};

let provider: ChatProvider = defaultProvider;

/** Test seam: inject a scripted provider (tests share the worker isolate). */
export function setChatProvider(custom: ChatProvider | null): void {
  provider = custom ?? defaultProvider;
}

export function chat(env: Env, input: ChatInput): Promise<ChatResult> {
  return provider(env, input);
}

/** #18 registry → function-calling tool schemas. */
export function toolSchemas(): { type: 'function'; function: unknown }[] {
  return [...toolRegistry.values()].map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.input_schema),
    },
  }));
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

const MAX_CONTEXT_BYTES = 100 * 1024;
const TOOL_RESULT_CAP = 8 * 1024;

/**
 * Rolling window: system prompt + task prompt + the last 12 transcript
 * entries (tool results truncated to 8 KiB), with pinned state (head_cs,
 * budget, open errors). Hard cap ~100 KiB — oldest tool results trimmed first.
 */
export function buildMessages(
  state: {
    transcript: TranscriptEntry[];
    head_cs: string;
    base_cs: string;
    budget: TaskBudget;
    error?: string;
  },
  taskPrompt: string,
): ChatMessage[] {
  const window = state.transcript.slice(-12).map((entry) => {
    const asText =
      entry.kind === 'tool_result'
        ? JSON.stringify(entry.output ?? {}).slice(0, TOOL_RESULT_CAP)
        : entry.kind === 'tool_call'
          ? `${entry.name} ${JSON.stringify(entry.input ?? {})}`
          : (entry.text ?? '');
    return {
      role: (entry.kind === 'llm' ? 'assistant' : 'user') as 'assistant' | 'user',
      content: `[${entry.kind}] ${asText}`.slice(0, TOOL_RESULT_CAP),
    };
  });

  const pinned = `Pinned state: head_cs=${state.head_cs}; base_cs=${state.base_cs}; budget=${JSON.stringify(remaining(state.budget))}${
    state.error ? `; open error: ${state.error}` : ''
  }`;

  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${pinned}` },
    { role: 'user', content: taskPrompt },
    ...window,
  ];

  // hard cap: trim oldest tool results first
  let serialized = JSON.stringify(messages).length;
  const start = 2;
  while (serialized > MAX_CONTEXT_BYTES && start < messages.length) {
    const removed = messages.splice(start, 1)[0];
    serialized -= removed?.content.length ?? 0;
  }
  return messages;
}

export { SYSTEM_PROMPT };
