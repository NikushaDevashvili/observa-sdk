/**
 * Vercel AI SDK Wrapper
 *
 * Wraps Vercel AI SDK functions (generateText, streamText, etc.) with automatic tracing.
 * Vercel AI SDK is a unified SDK that works with multiple providers (OpenAI, Anthropic, Google, etc.)
 *
 * Uses function wrapping pattern (not Proxy) since Vercel AI SDK exports functions, not classes.
 * Handles streaming with proper teeing (preserves TTFT).
 * Includes PII redaction hooks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { wrapStream } from "./utils";
import { getTraceContext, waitUntil } from "../context";
import { extractProviderError } from "./error-utils";
import {
  buildNormalizedLLMCall,
  buildOtelMetadata,
  normalizeToolDefinitions,
} from "./normalize";

// Type for Vercel AI SDK functions (avoid direct import to handle optional dependency)
type GenerateTextFn = any;
type StreamTextFn = any;

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === "object") {
        if (seen.has(val)) {
          return "[circular]";
        }
        seen.add(val);
      }
      if (typeof val === "bigint") {
        return val.toString();
      }
      if (typeof val === "symbol") {
        return val.toString();
      }
      if (typeof val === "function") {
        return "[function]";
      }
      return val;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

export interface ObserveOptions {
  name?: string;
  tags?: string[];
  userId?: string;
  sessionId?: string;
  // Callback to scrub PII before sending to Observa
  redact?: (data: any) => any;
  // Observa instance for sending events
  observa?: any; // Observa class instance
  // Callback to capture trace/span for linking feedback
  onLLMSpan?: (info: {
    traceId: string | null;
    spanId: string;
    responseId?: string | null;
    model?: string | null;
  }) => void;
}

/**
 * Extract provider name from model (string or object)
 * Handles both string models (e.g., "openai/gpt-4") and Vercel AI SDK model objects
 */
function extractProviderFromModel(model: any): string {
  if (!model) return "unknown";

  // Handle model objects (Vercel AI SDK style: openai("gpt-4") returns an object)
  if (typeof model === "object" && model !== null) {
    // Vercel AI SDK model objects have providerId property
    if (model.providerId) {
      return model.providerId.toLowerCase();
    }
    // Fallback: check for provider property
    if (model.provider) {
      return String(model.provider).toLowerCase();
    }
    // Try to infer from modelId
    if (model.modelId) {
      const modelId = String(model.modelId).toLowerCase();
      if (modelId.includes("gpt") || modelId.includes("openai")) {
        return "openai";
      }
      if (modelId.includes("claude") || modelId.includes("anthropic")) {
        return "anthropic";
      }
      if (modelId.includes("gemini") || modelId.includes("google")) {
        return "google";
      }
    }
    return "unknown";
  }

  // Handle string models
  if (typeof model === "string") {
    const parts = model.split("/");
    if (parts.length > 1 && parts[0]) {
      return parts[0].toLowerCase();
    }
    // Fallback: infer from model name
    const modelLower = model.toLowerCase();
    if (modelLower.includes("gpt") || modelLower.includes("openai")) {
      return "openai";
    }
    if (modelLower.includes("claude") || modelLower.includes("anthropic")) {
      return "anthropic";
    }
    if (modelLower.includes("gemini") || modelLower.includes("google")) {
      return "google";
    }
  }

  return "unknown";
}

/**
 * Extract model identifier string from model (string or object)
 * Returns a string representation suitable for tracking
 */
function extractModelIdentifier(model: any): string {
  if (!model) return "unknown";

  // Handle model objects (Vercel AI SDK style)
  if (typeof model === "object" && model !== null) {
    // Prefer modelId if available
    if (model.modelId) {
      return String(model.modelId);
    }
    // Fallback: construct from providerId + modelId if both exist
    if (model.providerId && model.modelId) {
      return `${model.providerId}/${model.modelId}`;
    }
    // Fallback: use providerId if that's all we have
    if (model.providerId) {
      return String(model.providerId);
    }
    // Last resort: try to stringify (may not be useful)
    try {
      return JSON.stringify(model);
    } catch {
      return "unknown";
    }
  }

  // Handle string models
  if (typeof model === "string") {
    return model;
  }

  return "unknown";
}

function resolveModelForTracking(...candidates: any[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = extractModelIdentifier(candidate);
    if (resolved && resolved !== "unknown") return resolved;
  }
  return "unknown";
}

function estimateTokensFromText(
  text: string | null | undefined,
): number | null {
  if (!text) return null;
  return Math.ceil(text.length / 4);
}

function estimateCostFromModel(
  model: string | null | undefined,
  totalTokens: number | null,
): number | null {
  if (!model || totalTokens === null || totalTokens === undefined) return null;
  const normalized = String(model).toLowerCase();
  const modelName = normalized.includes("/")
    ? normalized.split("/").pop() || normalized
    : normalized;
  const pricing: Array<{ match: string; pricePer1K: number }> = [
    { match: "gpt-4o-mini", pricePer1K: 0.003 },
    { match: "gpt-4o", pricePer1K: 0.015 },
    { match: "gpt-4-turbo", pricePer1K: 0.01 },
    { match: "gpt-4", pricePer1K: 0.03 },
    { match: "gpt-3.5", pricePer1K: 0.002 },
    { match: "claude-3-opus", pricePer1K: 0.03 },
    { match: "claude-3-sonnet", pricePer1K: 0.012 },
    { match: "claude-3-haiku", pricePer1K: 0.0025 },
  ];
  const matched = pricing.find((entry) => modelName.includes(entry.match));
  const pricePer1K = matched ? matched.pricePer1K : 0.002;
  return (totalTokens / 1000) * pricePer1K;
}

function normalizeMessages(messages: any): any[] {
  if (!messages) return [];
  if (Array.isArray(messages)) return messages;
  return [messages];
}

function buildSystemInstructions(
  system: any,
): Array<{ type: string; content: any }> | null {
  if (!system) return null;
  if (Array.isArray(system)) {
    return system.map((item) => ({
      type: "system",
      content: item,
    }));
  }
  return [{ type: "system", content: system }];
}

function prependSystemMessage(
  messages: any[] | null,
  system: any,
): any[] | null {
  if (!system) return messages;
  const normalized = messages ? [...messages] : [];
  const firstRole = normalized[0]?.role;
  if (firstRole === "system") return normalized;
  return [{ role: "system", content: system }, ...normalized];
}

function extractMessageText(message: any): string {
  if (!message) return "";
  const content = message.content ?? message.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c.text || c.type))
      .filter(Boolean)
      .join("\n");
  }
  return message.text || "";
}

/**
 * Extract only new messages from a conversation (last user message + any messages after it)
 * This prevents duplicating the full conversation history in each trace.
 *
 * Example:
 * - Full conversation: [user1, assistant1, tool1, user2, assistant2, user3]
 * - Returns: [user3] (only the new user message)
 *
 * If there are assistant/tool responses after the last user message, include those too:
 * - Full conversation: [user1, assistant1, user2, assistant2, tool2]
 * - Returns: [user2, assistant2, tool2] (new user message + responses in this call)
 */
function extractNewMessages(messages: any[]): any[] {
  if (!messages || messages.length === 0) return [];

  // Find the last user message index
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // If we found a user message, return from that message onwards
  // This includes: last user message + any assistant/tool responses after it
  if (lastUserIndex >= 0) {
    return messages.slice(lastUserIndex);
  }

  // Fallback: if no user message found, return the last message (might be assistant/tool)
  // This handles edge cases where conversation starts with assistant message
  return messages.slice(-1);
}

function extractOutputMessages(res: any): any[] | null {
  const candidates = [
    res?.messages,
    res?.response?.messages,
    res?.fullResponse?.messages,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMessages(candidate);
    if (normalized.length > 0) return normalized;
  }
  return null;
}

function extractOutputTextFromMessages(messages: any[] | null): string | null {
  if (!messages || messages.length === 0) return null;
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m?.role === "assistant" || m?.role === "model");
  if (lastAssistant) {
    const extracted = extractMessageText(lastAssistant);
    return extracted || null;
  }
  return messages
    .map((m) => extractMessageText(m))
    .filter(Boolean)
    .join("\n");
}

async function resolveUsageFromResult(result: any): Promise<any> {
  let usage: any = {};
  try {
    if (result?.usage) {
      usage = await Promise.resolve(result.usage);
    }
    if (!usage || Object.keys(usage).length === 0) {
      if (result?.fullResponse?.usage) {
        usage = await Promise.resolve(result.fullResponse.usage);
      } else if (result?.response?.usage) {
        usage = await Promise.resolve(result.response.usage);
      }
    }
  } catch {
    usage = usage || {};
  }
  return usage || {};
}

type ToolCallInfo = {
  toolName: string;
  args?: any;
  result?: any;
  toolCallId?: string | null;
  resultStatus: "success" | "error" | "timeout";
  errorMessage?: string;
  latencyMs?: number;
};

function extractToolCallsFromMessages(messages: any[]): ToolCallInfo[] {
  const toolCalls: ToolCallInfo[] = [];
  for (const message of messages) {
    const callCandidates = [
      message?.toolCalls,
      message?.tool_calls,
      message?.toolCall,
    ];
    for (const candidate of callCandidates) {
      const calls = normalizeMessages(candidate);
      for (const call of calls) {
        const toolName =
          call?.toolName ||
          call?.name ||
          call?.function?.name ||
          call?.tool?.name;
        if (!toolName) continue;
        const args =
          call?.args || call?.arguments || call?.function?.arguments || null;
        const result = call?.result || call?.output || call?.response || null;
        const errorMessage = call?.errorMessage || call?.error?.message;
        toolCalls.push({
          toolName,
          args: args || undefined,
          result: result || undefined,
          toolCallId:
            call?.toolCallId || call?.tool_call_id || call?.id || null,
          resultStatus: errorMessage ? "error" : result ? "success" : "success",
          errorMessage,
        });
      }
    }

    if (message?.role === "tool" && message?.name) {
      toolCalls.push({
        toolName: message.name,
        args: undefined,
        result: message?.content ?? message?.result ?? null,
        toolCallId: message?.toolCallId || message?.tool_call_id || null,
        resultStatus: "success",
      });
    }
  }
  return toolCalls;
}

function extractToolCallsFromResponse(res: any): ToolCallInfo[] {
  const toolCalls: ToolCallInfo[] = [];
  const candidates = [
    res?.toolCalls,
    res?.tool_calls,
    res?.response?.toolCalls,
    res?.response?.tool_calls,
    res?.fullResponse?.toolCalls,
    res?.fullResponse?.tool_calls,
  ];
  for (const candidate of candidates) {
    const calls = normalizeMessages(candidate);
    for (const call of calls) {
      const toolName =
        call?.toolName ||
        call?.name ||
        call?.function?.name ||
        call?.tool?.name;
      if (!toolName) continue;
      const args =
        call?.args || call?.arguments || call?.function?.arguments || null;
      const result = call?.result || call?.output || call?.response || null;
      const errorMessage = call?.errorMessage || call?.error?.message;
      toolCalls.push({
        toolName,
        args: args || undefined,
        result: result || undefined,
        toolCallId: call?.toolCallId || call?.tool_call_id || call?.id || null,
        resultStatus: errorMessage ? "error" : result ? "success" : "success",
        errorMessage,
      });
    }
  }

  const steps = normalizeMessages(res?.steps);
  for (const step of steps) {
    const stepToolCalls = normalizeMessages(
      step?.toolCalls || step?.tool_calls,
    );
    for (const call of stepToolCalls) {
      const toolName =
        call?.toolName ||
        call?.name ||
        call?.function?.name ||
        call?.tool?.name;
      if (!toolName) continue;
      const args =
        call?.args || call?.arguments || call?.function?.arguments || null;
      const result = call?.result || call?.output || call?.response || null;
      const errorMessage = call?.errorMessage || call?.error?.message;
      toolCalls.push({
        toolName,
        args: args || undefined,
        result: result || undefined,
        toolCallId: call?.toolCallId || call?.tool_call_id || call?.id || null,
        resultStatus: errorMessage ? "error" : result ? "success" : "success",
        errorMessage,
      });
    }
  }

  const messageToolCalls = extractToolCallsFromMessages(
    normalizeMessages(res?.messages),
  );
  return [...toolCalls, ...messageToolCalls];
}

function attachFeedbackHelpers(
  target: any,
  traceInfo: {
    traceId: string | null;
    spanId: string;
    responseId?: string | null;
    model?: string | null;
  },
  options?: ObserveOptions,
): void {
  if (!target || !traceInfo) return;
  const traceId = traceInfo.traceId;
  const spanId = traceInfo.spanId;
  const submitFeedback =
    options?.observa?.trackFeedback && traceId && spanId
      ? (feedback: {
          type: "like" | "dislike" | "rating" | "correction";
          rating?: number;
          comment?: string;
          outcome?: "success" | "failure" | "partial";
          conversationId?: string;
          sessionId?: string;
          userId?: string;
          metadata?: Record<string, any>;
        }) =>
          options.observa.trackFeedback({
            ...feedback,
            traceId,
            parentSpanId: spanId,
          })
      : undefined;

  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:attachFeedbackHelpers",
      message: "attached feedback helpers",
      data: {
        hasTraceId: !!traceId,
        hasSpanId: !!spanId,
        hasSubmitFeedback: !!submitFeedback,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "F",
    }),
  }).catch(() => {});
  // #endregion

  // Convenience methods for like/dislike feedback
  const like = submitFeedback
    ? (opts?: {
        comment?: string;
        conversationId?: string;
        sessionId?: string;
        userId?: string;
      }) =>
        submitFeedback({
          type: "like",
          outcome: "success",
          ...opts,
        })
    : undefined;

  const dislike = submitFeedback
    ? (opts?: {
        comment?: string;
        conversationId?: string;
        sessionId?: string;
        userId?: string;
      }) =>
        submitFeedback({
          type: "dislike",
          outcome: "failure",
          ...opts,
        })
    : undefined;

  target.observa = {
    ...(target.observa || {}),
    traceId,
    spanId,
    responseId: traceInfo.responseId ?? null,
    model: traceInfo.model ?? null,
    submitFeedback,
    like,
    dislike,
  };
}

function attachResultMetadata(
  target: any,
  metadata: {
    traceId: string | null;
    spanId: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    cost?: number | null;
    inputCost?: number | null;
    outputCost?: number | null;
    toolCalls?: ToolCallInfo[];
    inputText?: string | null;
    outputText?: string | null;
  },
): void {
  if (!target || !metadata) return;
  target.observa = {
    ...(target.observa || {}),
    traceId: metadata.traceId,
    spanId: metadata.spanId,
    usage: {
      inputTokens: metadata.inputTokens ?? null,
      outputTokens: metadata.outputTokens ?? null,
      totalTokens: metadata.totalTokens ?? null,
    },
    cost: metadata.cost ?? null,
    inputCost: metadata.inputCost ?? null,
    outputCost: metadata.outputCost ?? null,
    toolCalls: metadata.toolCalls || [],
    inputText: metadata.inputText ?? null,
    outputText: metadata.outputText ?? null,
  };
}

/**
 * Wrap tools to track tool calls
 * Returns a new requestParams object with wrapped tools, or null if no tools to wrap
 */
function wrapToolsForTracking(
  requestParams: any,
  options?: ObserveOptions,
  toolCallBuffer?: ToolCallInfo[],
): { requestParams: any; toolsWrapped: boolean } | null {
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:wrapToolsForTracking",
      message: "wrapToolsForTracking entry",
      data: {
        hasTools: !!requestParams.tools,
        toolsType: typeof requestParams.tools,
        hasOptions: !!options,
        hasObserva: !!options?.observa,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "D",
    }),
  }).catch(() => {});
  // #endregion
  if (!requestParams.tools || !options?.observa) {
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:wrapToolsForTracking",
        message: "wrapToolsForTracking returning null",
        data: {
          hasTools: !!requestParams.tools,
          toolsType: typeof requestParams.tools,
          hasObserva: !!options?.observa,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "D",
      }),
    }).catch(() => {});
    // #endregion
    return null;
  }

  const wrapToolExecute = (toolName: string, tool: any): any => {
    if (!tool) return tool;
    if (typeof tool === "function") {
      const originalFn = tool;
      const wrappedFn = async (...executeArgs: any[]) => {
        const toolStartTime = Date.now();
        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "vercel-ai.ts:wrapToolsForTracking",
              message: "Tool execute called",
              data: {
                toolName,
                hasArgs: executeArgs.length > 0,
                argsPreview: executeArgs[0]
                  ? safeJsonStringify(executeArgs[0]).substring(0, 100)
                  : null,
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "A",
            }),
          },
        ).catch(() => {});
        // #endregion
        try {
          const result = await originalFn(...executeArgs);
          const latencyMs = Date.now() - toolStartTime;
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "Tool execute success",
                data: {
                  toolName,
                  latencyMs,
                  hasResult: !!result,
                  resultType: typeof result,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A",
              }),
            },
          ).catch(() => {});
          // #endregion
          if (toolCallBuffer) {
            toolCallBuffer.push({
              toolName,
              args: executeArgs[0] || {},
              result,
              resultStatus: "success",
              latencyMs,
            });
          } else {
            options.observa.trackToolCall({
              toolName,
              args: executeArgs[0] || {},
              result: result,
              resultStatus: "success",
              latencyMs,
            });
          }
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "trackToolCall invoked (success)",
                data: { toolName, latencyMs },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "G",
              }),
            },
          ).catch(() => {});
          // #endregion
          return result;
        } catch (error: any) {
          const latencyMs = Date.now() - toolStartTime;
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "Tool execute error",
                data: {
                  toolName,
                  latencyMs,
                  errorMessage: error?.message,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A",
              }),
            },
          ).catch(() => {});
          // #endregion
          if (toolCallBuffer) {
            toolCallBuffer.push({
              toolName,
              args: executeArgs[0] || {},
              resultStatus: "error",
              errorMessage: error?.message || "Unknown error",
              latencyMs,
            });
          } else {
            options.observa.trackToolCall({
              toolName,
              args: executeArgs[0] || {},
              resultStatus: "error",
              latencyMs,
              errorMessage: error?.message || "Unknown error",
            });
          }
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "trackToolCall invoked (error)",
                data: { toolName, latencyMs },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "G",
              }),
            },
          ).catch(() => {});
          // #endregion
          throw error;
        }
      };
      return Object.assign(wrappedFn, originalFn);
    }
    if (typeof tool.execute !== "function") return tool;
    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (...executeArgs: any[]) => {
        const toolStartTime = Date.now();
        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "vercel-ai.ts:wrapToolsForTracking",
              message: "Tool execute called",
              data: {
                toolName,
                hasArgs: executeArgs.length > 0,
                argsPreview: executeArgs[0]
                  ? safeJsonStringify(executeArgs[0]).substring(0, 100)
                  : null,
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "A",
            }),
          },
        ).catch(() => {});
        // #endregion
        try {
          const result = await originalExecute(...executeArgs);
          const latencyMs = Date.now() - toolStartTime;
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "Tool execute success",
                data: {
                  toolName,
                  latencyMs,
                  hasResult: !!result,
                  resultType: typeof result,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A",
              }),
            },
          ).catch(() => {});
          // #endregion
          if (toolCallBuffer) {
            toolCallBuffer.push({
              toolName,
              args: executeArgs[0] || {},
              result,
              resultStatus: "success",
              latencyMs,
            });
          } else {
            options.observa.trackToolCall({
              toolName,
              args: executeArgs[0] || {},
              result: result,
              resultStatus: "success",
              latencyMs,
            });
          }
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "trackToolCall invoked (success)",
                data: { toolName, latencyMs },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "G",
              }),
            },
          ).catch(() => {});
          // #endregion
          return result;
        } catch (error: any) {
          const latencyMs = Date.now() - toolStartTime;
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "Tool execute error",
                data: {
                  toolName,
                  latencyMs,
                  errorMessage: error?.message,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A",
              }),
            },
          ).catch(() => {});
          // #endregion
          if (toolCallBuffer) {
            toolCallBuffer.push({
              toolName,
              args: executeArgs[0] || {},
              resultStatus: "error",
              errorMessage: error?.message || "Unknown error",
              latencyMs,
            });
          } else {
            options.observa.trackToolCall({
              toolName,
              args: executeArgs[0] || {},
              resultStatus: "error",
              latencyMs,
              errorMessage: error?.message || "Unknown error",
            });
          }
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "vercel-ai.ts:wrapToolsForTracking",
                message: "trackToolCall invoked (error)",
                data: { toolName, latencyMs },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "G",
              }),
            },
          ).catch(() => {});
          // #endregion
          throw error;
        }
      },
    };
  };

  const tools = requestParams.tools;
  let hasWrappedTool = false;
  let wrappedTools: any = tools;

  if (Array.isArray(tools)) {
    wrappedTools = tools.map((tool: any) => {
      const toolName = tool?.name || tool?.toolName || "unknown";
      const wrapped = wrapToolExecute(toolName, tool);
      if (wrapped !== tool) hasWrappedTool = true;
      return wrapped;
    });
  } else if (tools instanceof Map) {
    const wrappedMap = new Map();
    for (const [toolName, toolDef] of tools.entries()) {
      const wrapped = wrapToolExecute(String(toolName), toolDef);
      if (wrapped !== toolDef) hasWrappedTool = true;
      wrappedMap.set(toolName, wrapped);
    }
    wrappedTools = wrappedMap;
  } else if (typeof tools === "object") {
    const wrappedObj: any = {};
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const wrapped = wrapToolExecute(toolName, toolDef);
      if (wrapped !== toolDef) hasWrappedTool = true;
      wrappedObj[toolName] = wrapped;
    }
    wrappedTools = wrappedObj;
  }

  return {
    requestParams: { ...requestParams, tools: wrappedTools },
    toolsWrapped: hasWrappedTool,
  };
}

/**
 * Trace a generateText call
 */
async function traceGenerateText(
  originalFn: GenerateTextFn,
  args: any[],
  options?: ObserveOptions,
) {
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const model = requestParams.model || "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);
  const preCallTools = requestParams?.tools ?? null;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:traceGenerateText",
      message: "generateText model inputs",
      data: {
        modelType: typeof requestParams.model,
        modelIdentifier,
        provider,
        hasMessages: Array.isArray(requestParams.messages),
        hasPrompt: !!requestParams.prompt,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "A",
    }),
  }).catch(() => {});
  // #endregion

  let traceStarted = false;
  let startedTraceId: string | null = null;
  const hasActiveTraceFn =
    typeof options?.observa?.hasActiveTrace === "function";
  const hasActiveTrace = hasActiveTraceFn
    ? options.observa.hasActiveTrace()
    : false;
  const existingTraceId =
    options?.observa?.getCurrentTraceId &&
    typeof options.observa.getCurrentTraceId === "function"
      ? options.observa.getCurrentTraceId()
      : null;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:traceGenerateText",
      message: "trace start decision",
      data: {
        hasActiveTraceFn,
        hasActiveTrace,
        existingTraceId,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "L",
    }),
  }).catch(() => {});
  // #endregion
  if (hasActiveTraceFn && !hasActiveTrace) {
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:traceGenerateText",
        message: "Starting new trace for generateText",
        data: { hasObserva: !!options?.observa },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "F",
      }),
    }).catch(() => {});
    // #endregion
    startedTraceId = options.observa.startTrace({ name: options?.name });
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:traceGenerateText",
        message: "startTrace return value",
        data: {
          startedTraceId,
          currentTraceId: options?.observa?.getCurrentTraceId
            ? options.observa.getCurrentTraceId()
            : null,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "H",
      }),
    }).catch(() => {});
    // #endregion
    traceStarted = true;
  }
  const traceIdForRequest = startedTraceId || existingTraceId;

  // Extract input text early (before operation starts) to ensure it's captured even on errors
  let inputText: string | null = null;
  let inputMessages: any = null;
  if (requestParams.prompt) {
    if (Array.isArray(requestParams.prompt)) {
      inputMessages = requestParams.prompt;
      inputText = requestParams.prompt
        .map((m: any) => extractMessageText(m))
        .filter(Boolean)
        .join("\n");
    } else {
      inputText =
        typeof requestParams.prompt === "string"
          ? requestParams.prompt
          : safeJsonStringify(requestParams.prompt);
    }
  } else if (requestParams.messages) {
    // Extract only new messages (last user message + any messages after it)
    // This prevents duplicating the full conversation history in each trace
    const normalizedMessages = normalizeMessages(requestParams.messages);
    inputMessages = extractNewMessages(normalizedMessages);
    // But still extract full text from all messages for inputText (for token counting)
    inputText = normalizedMessages
      .map((m: any) => {
        // Handle string content
        if (typeof m.content === "string") return m.content;
        // Handle array content (e.g., [{type: "text", text: "..."}])
        if (Array.isArray(m.content)) {
          return m.content
            .map((c: any) => (typeof c === "string" ? c : c.text || c.type))
            .filter(Boolean)
            .join("\n");
        }
        // Fallback to text property or empty string
        return m.text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  inputMessages = prependSystemMessage(inputMessages, requestParams.system);

  const toolCallBuffer: ToolCallInfo[] = [];

  // Wrap tools to track tool calls
  const wrapResult = wrapToolsForTracking(
    requestParams,
    options,
    toolCallBuffer,
  );
  const toolsWrapped = wrapResult?.toolsWrapped ?? false;
  if (wrapResult?.requestParams) {
    args[0] = wrapResult.requestParams;
  }

  try {
    const result = await originalFn(...args);

    // Extract response data
    const responseText = result.text || "";
    const usage = await resolveUsageFromResult(result);
    const finishReason = result.finishReason || null;
    const responseId = result.response?.id || null;
    const responseMessages =
      result.messages ||
      result.response?.messages ||
      result.fullResponse?.messages;

    // Extract model from response if available, otherwise use identifier
    const responseModel = result.model
      ? extractModelIdentifier(result.model)
      : modelIdentifier;

    // Record trace
    const traceInfo = recordTrace(
      requestParams, // Pass full requestParams to extract tools, toolChoice, etc.
      {
        text: responseText,
        usage,
        finishReason,
        responseId,
        model: responseModel,
        messages: responseMessages || null,
      },
      startTime,
      options,
      null, // No streaming for generateText
      null,
      provider,
      traceStarted,
      toolsWrapped,
      toolCallBuffer,
      traceIdForRequest,
      preCallTools,
    );

    if (traceInfo) {
      attachFeedbackHelpers(
        result,
        {
          traceId: traceInfo.traceId,
          spanId: traceInfo.spanId,
          responseId,
          model: responseModel,
        },
        options,
      );
      attachResultMetadata(result, traceInfo);
    }

    return result;
  } catch (error) {
    recordError(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt || null,
        messages: requestParams.messages || null,
        temperature: requestParams.temperature || null,
        maxTokens: requestParams.maxTokens || requestParams.max_tokens || null,
      },
      error,
      startTime,
      options,
      provider,
      inputText,
      inputMessages,
      traceStarted,
      toolCallBuffer,
      traceIdForRequest,
      preCallTools,
    );
    throw error;
  }
}

/**
 * Wrap ReadableStream to capture data while preserving ReadableStream interface
 * Uses tee() to split stream - one for user, one for tracking
 * This preserves the ReadableStream interface that toTextStreamResponse() expects
 */
function wrapReadableStream(
  stream: ReadableStream<Uint8Array>,
  onComplete: (fullData: any) => void | Promise<void>,
  onError: (error: any) => void,
  allowEmptyResponse?: () => boolean,
): ReadableStream<Uint8Array> {
  // Use tee() to split the stream - one for user, one for tracking
  const [userStream, trackingStream] = stream.tee();
  const decoder = new TextDecoder();
  let firstTokenTime: number | null = null;
  const streamStartTime = Date.now();
  const chunks: string[] = [];

  // Process tracking stream in background (don't block user)
  // This allows us to capture the full response without delaying the user stream
  (async () => {
    const timeoutMs = 300000; // 5 minutes default timeout
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const reader = trackingStream.getReader();

      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reader.cancel(); // Cancel the reader
          reject(
            new Error(
              `Stream timeout after ${timeoutMs}ms - no response received`,
            ),
          );
        }, timeoutMs);
      });

      // Race between stream reading and timeout
      while (true) {
        const readPromise = reader.read();
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } catch (error) {
          // If reader.read() rejects, it means the stream errored
          // Clear timeout on error
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          // Re-throw to be caught by outer catch block
          throw error;
        }

        const { done, value } = result;
        if (done) break;

        // Clear timeout on first chunk
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (firstTokenTime === null && value !== null && value !== undefined) {
          firstTokenTime = Date.now();
        }

        // Handle both string and binary values
        // Vercel AI SDK's textStream can yield either strings or Uint8Array
        let text: string;
        if (typeof value === "string") {
          // Value is already a string
          text = value;
        } else if (value !== null && value !== undefined) {
          // Check if value is binary data (Uint8Array or ArrayBufferView)
          try {
            // Try to decode - if it fails, it's not binary data
            const testValue = value as any;
            if (
              testValue instanceof Uint8Array ||
              (typeof ArrayBuffer !== "undefined" &&
                typeof ArrayBuffer.isView === "function" &&
                ArrayBuffer.isView(testValue))
            ) {
              // Value is binary data - decode it
              text = decoder.decode(testValue, { stream: true });
            } else {
              // Not binary data - convert to string
              text = String(value);
            }
          } catch {
            // If decoding fails, treat as string
            text = String(value);
          }
        } else {
          // Skip null/undefined values
          continue;
        }
        chunks.push(text);
      }

      // Clear timeout if stream completed successfully
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // Stream completed - reconstruct full response
      const fullText = chunks.join("");

      // CRITICAL FIX: Check if response is empty (including case where stream completes with no chunks)
      if (chunks.length === 0 || !fullText || fullText.trim().length === 0) {
        console.error("[Observa] Empty response detected:", {
          chunks: chunks.length,
          fullTextLength: fullText?.length || 0,
        });
        const shouldAllowEmpty = allowEmptyResponse
          ? allowEmptyResponse()
          : false;
        if (!shouldAllowEmpty) {
          onError({
            name: "EmptyResponseError",
            message:
              "AI returned empty response. This usually indicates an error occurred during stream processing. Check server logs for the actual error details (the error may have been thrown during stream consumption and not captured by instrumentation).",
            errorType: "empty_response",
            errorCategory: "model_error",
            chunks: chunks.length,
            fullText: fullText || "",
          });
          return; // Don't call onComplete for empty responses
        }
      }

      // Call onComplete - handle both sync and async callbacks
      Promise.resolve(
        onComplete({
          text: fullText,
          timeToFirstToken: firstTokenTime
            ? firstTokenTime - streamStartTime
            : null,
          streamingDuration: firstTokenTime
            ? Date.now() - firstTokenTime
            : null,
          totalLatency: Date.now() - streamStartTime,
        }),
      ).catch((e) => {
        console.error("[Observa] Error in onComplete callback:", e);
        onError(e);
      });
    } catch (error) {
      // Clear timeout on error
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // Check if it's a timeout error
      if (error instanceof Error && error.message.includes("timeout")) {
        onError({
          ...error,
          name: "StreamTimeoutError",
          errorType: "timeout_error",
          errorCategory: "timeout_error",
        });
      } else {
        onError(error);
      }
    }
  })();

  // Return user stream (original ReadableStream interface preserved)
  return userStream;
}

/**
 * Trace a streamText call
 */
async function traceStreamText(
  originalFn: StreamTextFn,
  args: any[],
  options?: ObserveOptions,
) {
  // #region agent log
  console.log("[Observa DEBUG] traceStreamText entry:", {
    hasOptions: !!options,
    hasObserva: !!options?.observa,
    argsLength: args.length,
  });
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:375",
      message: "traceStreamText entry",
      data: {
        hasOptions: !!options,
        hasObserva: !!options?.observa,
        argsLength: args.length,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "E",
    }),
  }).catch(() => {});
  // #endregion
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const model = requestParams.model || "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);
  const preCallTools = requestParams?.tools ?? null;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:traceStreamText",
      message: "streamText model inputs",
      data: {
        modelType: typeof requestParams.model,
        modelIdentifier,
        provider,
        hasMessages: Array.isArray(requestParams.messages),
        hasPrompt: !!requestParams.prompt,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "A",
    }),
  }).catch(() => {});
  // #endregion

  // Extract input text early (before operation starts) to ensure it's captured even on errors
  let inputText: string | null = null;
  let inputMessages: any = null;
  if (requestParams.prompt) {
    if (Array.isArray(requestParams.prompt)) {
      inputMessages = requestParams.prompt;
      inputText = requestParams.prompt
        .map((m: any) => extractMessageText(m))
        .filter(Boolean)
        .join("\n");
    } else {
      inputText =
        typeof requestParams.prompt === "string"
          ? requestParams.prompt
          : safeJsonStringify(requestParams.prompt);
    }
  } else if (requestParams.messages) {
    // Extract only new messages (last user message + any messages after it)
    // This prevents duplicating the full conversation history in each trace
    const normalizedMessages = normalizeMessages(requestParams.messages);
    inputMessages = extractNewMessages(normalizedMessages);
    // But still extract full text from all messages for inputText (for token counting)
    inputText = normalizedMessages
      .map((m: any) => extractMessageText(m))
      .filter(Boolean)
      .join("\n");
  }
  inputMessages = prependSystemMessage(inputMessages, requestParams.system);

  const toolCallBuffer: ToolCallInfo[] = [];

  const messageRoles = Array.isArray(requestParams.messages)
    ? requestParams.messages.map((m: any) => m.role || "unknown")
    : [];
  const lastUserMessage = Array.isArray(requestParams.messages)
    ? [...requestParams.messages].reverse().find((m: any) => m.role === "user")
    : null;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:traceStreamText",
      message: "messages summary before trace",
      data: {
        messagesCount: Array.isArray(requestParams.messages)
          ? requestParams.messages.length
          : 0,
        firstRole: messageRoles[0] || null,
        lastRole: messageRoles[messageRoles.length - 1] || null,
        lastUserMessagePreview: lastUserMessage?.content
          ? safeJsonStringify(lastUserMessage.content).substring(0, 100)
          : null,
        hasActiveTraceMethod:
          typeof options?.observa?.hasActiveTrace === "function",
        currentTraceId: options?.observa?.getCurrentTraceId
          ? options.observa.getCurrentTraceId()
          : null,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "K",
    }),
  }).catch(() => {});
  // #endregion

  let traceStarted = false;
  let startedTraceId: string | null = null;
  const hasActiveTraceFn =
    typeof options?.observa?.hasActiveTrace === "function";
  const hasActiveTrace = hasActiveTraceFn
    ? options.observa.hasActiveTrace()
    : false;
  const existingTraceId =
    options?.observa?.getCurrentTraceId &&
    typeof options.observa.getCurrentTraceId === "function"
      ? options.observa.getCurrentTraceId()
      : null;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:traceStreamText",
      message: "trace start decision",
      data: {
        hasActiveTraceFn,
        hasActiveTrace,
        existingTraceId,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "L",
    }),
  }).catch(() => {});
  // #endregion
  if (hasActiveTraceFn && !hasActiveTrace) {
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:traceStreamText",
        message: "Starting new trace for streamText",
        data: { hasObserva: !!options?.observa },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "F",
      }),
    }).catch(() => {});
    // #endregion
    startedTraceId = options.observa.startTrace({ name: options?.name });
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:traceStreamText",
        message: "startTrace return value",
        data: {
          startedTraceId,
          currentTraceId: options?.observa?.getCurrentTraceId
            ? options.observa.getCurrentTraceId()
            : null,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "H",
      }),
    }).catch(() => {});
    // #endregion
    traceStarted = true;
  }
  const traceIdForRequest = startedTraceId || existingTraceId;

  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:624",
      message: "Before wrapToolsForTracking - checking requestParams",
      data: {
        hasTools: !!requestParams.tools,
        toolsType: typeof requestParams.tools,
        toolsKeys: requestParams.tools ? Object.keys(requestParams.tools) : [],
        toolsCount: requestParams.tools
          ? Object.keys(requestParams.tools).length
          : 0,
        hasOptions: !!options,
        hasObserva: !!options?.observa,
        requestParamsKeys: Object.keys(requestParams),
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "D",
    }),
  }).catch(() => {});
  // #endregion

  // Wrap tools to track tool calls
  const wrapResult = wrapToolsForTracking(
    requestParams,
    options,
    toolCallBuffer,
  );
  const toolsWrapped = wrapResult?.toolsWrapped ?? false;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:650",
      message: "After wrapToolsForTracking",
      data: {
        hasWrappedRequestParams: !!wrapResult?.requestParams,
        wrappedToolsKeys:
          wrapResult?.requestParams?.tools &&
          typeof wrapResult.requestParams.tools === "object"
            ? Object.keys(wrapResult.requestParams.tools)
            : [],
        toolsWrapped,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "D",
    }),
  }).catch(() => {});
  // #endregion
  if (wrapResult?.requestParams) {
    args[0] = wrapResult.requestParams;
  }

  try {
    const result = await originalFn(...args);
    // #region agent log
    console.log("[Observa DEBUG] after originalFn call:", {
      hasTextStream: !!result.textStream,
      hasUsage: !!result.usage,
      resultKeys: Object.keys(result),
      textStreamType: typeof result.textStream,
    });
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:398",
        message: "after originalFn call",
        data: {
          hasTextStream: !!result.textStream,
          hasUsage: !!result.usage,
          resultKeys: Object.keys(result),
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "C",
      }),
    }).catch(() => {});
    // #endregion
    // Vercel AI SDK streamText returns an object with .textStream property
    // textStream is a ReadableStream in modern Vercel AI SDK versions
    // We use tee() to split it, preserving the ReadableStream interface
    if (result.textStream) {
      const originalTextStream = result.textStream;
      let wrappedResult: any;

      // Check if textStream is a ReadableStream (has getReader method)
      // This is the standard way to detect ReadableStream
      const isReadableStream =
        originalTextStream &&
        typeof originalTextStream.getReader === "function";
      // #region agent log
      console.log("[Observa DEBUG] isReadableStream check:", {
        isReadableStream,
        hasGetReader: typeof originalTextStream?.getReader,
        textStreamConstructor: originalTextStream?.constructor?.name,
      });
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "vercel-ai.ts:412",
            message: "isReadableStream check",
            data: {
              isReadableStream,
              hasGetReader: typeof originalTextStream?.getReader,
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "C",
          }),
        },
      ).catch(() => {});
      // #endregion
      if (isReadableStream) {
        // It's a ReadableStream - use tee() to split it
        // This preserves the ReadableStream interface including pipeThrough
        const wrappedStream = wrapReadableStream(
          originalTextStream as ReadableStream<Uint8Array>,
          async (fullResponse: any) => {
            // #region agent log
            console.log("[Observa DEBUG] onComplete callback called:", {
              fullResponseKeys: Object.keys(fullResponse),
              hasText: !!fullResponse.text,
              textLength: fullResponse.text?.length,
              textPreview: fullResponse.text?.substring(0, 100),
            });
            fetch(
              "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "vercel-ai.ts:417",
                  message: "onComplete callback called",
                  data: {
                    fullResponseKeys: Object.keys(fullResponse),
                    hasText: !!fullResponse.text,
                    textLength: fullResponse.text?.length,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "A",
                }),
              },
            ).catch(() => {});
            // #endregion
            // CRITICAL FIX: Extract usage from result.usage (which may be a Promise)
            // Vercel AI SDK's streamText result.usage resolves when stream completes
            let usage: any = {};
            try {
              if (result.usage) {
                // Usage can be a Promise or a direct object
                usage = await Promise.resolve(result.usage);
              }
              // Also check result.fullResponse?.usage as fallback
              if (!usage || Object.keys(usage).length === 0) {
                if (result.fullResponse?.usage) {
                  usage = await Promise.resolve(result.fullResponse.usage);
                }
              }
            } catch (e) {
              // If usage extraction fails, continue with empty usage
              console.warn("[Observa] Failed to extract usage from result:", e);
            }
            // #region agent log
            fetch(
              "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "vercel-ai.ts:450",
                  message: "before recordTrace call",
                  data: {
                    usageKeys: Object.keys(usage),
                    fullResponseText: fullResponse.text?.substring(0, 50),
                    hasRequestParamsPrompt: !!requestParams.prompt,
                    hasRequestParamsMessages: !!requestParams.messages,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "B",
                }),
              },
            ).catch(() => {});
            // #endregion
            const responseMessages =
              result.messages ||
              result.response?.messages ||
              result.fullResponse?.messages;
            // Merge usage into fullResponse for recordTrace
            const traceInfo = recordTrace(
              requestParams, // Pass full requestParams to extract tools, toolChoice, etc.
              {
                ...fullResponse,
                usage: usage,
                finishReason: result.finishReason || null,
                responseId: result.response?.id || null,
                model: result.model
                  ? extractModelIdentifier(result.model)
                  : modelIdentifier,
                messages: responseMessages || null,
              },
              startTime,
              options,
              fullResponse.timeToFirstToken,
              fullResponse.streamingDuration,
              provider,
              traceStarted,
              toolsWrapped,
              toolCallBuffer,
              traceIdForRequest,
              preCallTools,
            );

            // #region agent log
            fetch(
              "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "vercel-ai.ts:traceStreamText",
                  message: "trace id before recordTrace",
                  data: {
                    startedTraceId,
                    currentTraceId: options?.observa?.getCurrentTraceId
                      ? options.observa.getCurrentTraceId()
                      : null,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "J",
                }),
              },
            ).catch(() => {});
            // #endregion

            if (traceInfo && wrappedResult) {
              attachFeedbackHelpers(
                wrappedResult,
                {
                  traceId: traceInfo.traceId,
                  spanId: traceInfo.spanId,
                  responseId: result.response?.id || null,
                  model: result.model
                    ? extractModelIdentifier(result.model)
                    : modelIdentifier,
                },
                options,
              );
              attachResultMetadata(wrappedResult, traceInfo);
            }
          },
          (err: any) =>
            recordError(
              {
                model: modelIdentifier,
                prompt: requestParams.prompt || null,
                messages: requestParams.messages || null,
                temperature: requestParams.temperature || null,
                maxTokens:
                  requestParams.maxTokens || requestParams.max_tokens || null,
              },
              err,
              startTime,
              options,
              provider,
              inputText,
              inputMessages,
              traceStarted,
              toolCallBuffer,
              traceIdForRequest,
              preCallTools,
            ),
          () => toolCallBuffer.length > 0,
        );

        // Return result with wrapped stream - preserve all original properties and methods
        // Use Object.create to preserve prototype chain (for methods like toTextStreamResponse)
        wrappedResult = Object.create(Object.getPrototypeOf(result));
        Object.assign(wrappedResult, result);

        // Override textStream with our wrapped ReadableStream
        // This preserves the ReadableStream interface that toTextStreamResponse() expects
        Object.defineProperty(wrappedResult, "textStream", {
          value: wrappedStream,
          writable: true,
          enumerable: true,
          configurable: true,
        });

        // Wrap methods that consume the stream to catch errors
        // This allows us to capture errors that happen during stream consumption
        if (typeof result.toUIMessageStreamResponse === "function") {
          const originalToUIMessageStreamResponse =
            result.toUIMessageStreamResponse.bind(result);
          wrappedResult.toUIMessageStreamResponse = function (...args: any[]) {
            try {
              return originalToUIMessageStreamResponse(...args);
            } catch (error) {
              // Capture error from stream consumption
              recordError(
                {
                  model: modelIdentifier,
                  prompt: requestParams.prompt || null,
                  messages: requestParams.messages || null,
                  temperature: requestParams.temperature || null,
                  maxTokens:
                    requestParams.maxTokens || requestParams.max_tokens || null,
                },
                error,
                startTime,
                options,
                provider,
                inputText,
                inputMessages,
                traceStarted,
                toolCallBuffer,
                traceIdForRequest,
                preCallTools,
              );
              throw error; // Re-throw so user sees the error
            }
          };
        }

        if (typeof result.toTextStreamResponse === "function") {
          const originalToTextStreamResponse =
            result.toTextStreamResponse.bind(result);
          wrappedResult.toTextStreamResponse = function (...args: any[]) {
            try {
              return originalToTextStreamResponse(...args);
            } catch (error) {
              // Capture error from stream consumption
              recordError(
                {
                  model: modelIdentifier,
                  prompt: requestParams.prompt || null,
                  messages: requestParams.messages || null,
                  temperature: requestParams.temperature || null,
                  maxTokens:
                    requestParams.maxTokens || requestParams.max_tokens || null,
                },
                error,
                startTime,
                options,
                provider,
                inputText,
                inputMessages,
                traceStarted,
                toolCallBuffer,
                traceIdForRequest,
                preCallTools,
              );
              throw error; // Re-throw so user sees the error
            }
          };
        }

        return wrappedResult;
      }
      // If textStream is not a ReadableStream (shouldn't happen in modern SDK),
      // we can't wrap it, so we can't get the streamed data
      // Log a warning but don't try to record trace (we don't have the data)
      console.warn(
        "[Observa] streamText result.textStream is not a ReadableStream - cannot track stream data",
      );
    }

    // If no textStream, this is unexpected for streamText
    // Don't call recordTrace because we can't get the data without the stream
    if (!result.textStream) {
      console.warn(
        "[Observa] streamText result has no textStream property - cannot track",
      );
    }

    if (!result.textStream || !result.textStream.getReader) {
      const responseText =
        result.text || result.fullResponse?.text || result.response?.text || "";
      const usage = await resolveUsageFromResult(result);
      const responseMessages =
        result.messages ||
        result.response?.messages ||
        result.fullResponse?.messages;
      const traceInfo = recordTrace(
        requestParams, // Pass full requestParams to extract tools, toolChoice, etc.
        {
          text: responseText,
          usage,
          finishReason: result.finishReason || null,
          responseId: result.response?.id || null,
          model: result.model
            ? extractModelIdentifier(result.model)
            : modelIdentifier,
          messages: responseMessages || null,
        },
        startTime,
        options,
        null,
        null,
        provider,
        traceStarted,
        toolsWrapped,
        toolCallBuffer,
        traceIdForRequest,
        preCallTools,
      );

      if (traceInfo) {
        attachFeedbackHelpers(
          result,
          {
            traceId: traceInfo.traceId,
            spanId: traceInfo.spanId,
            responseId: result.response?.id || null,
            model: result.model
              ? extractModelIdentifier(result.model)
              : modelIdentifier,
          },
          options,
        );
        attachResultMetadata(result, traceInfo);
      }
    }

    return result;
  } catch (error) {
    recordError(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt || null,
        messages: requestParams.messages || null,
        temperature: requestParams.temperature || null,
        maxTokens: requestParams.maxTokens || requestParams.max_tokens || null,
      },
      error,
      startTime,
      options,
      provider,
      inputText,
      inputMessages,
      traceStarted,
      toolCallBuffer,
      traceIdForRequest,
      preCallTools,
    );
    throw error;
  }
}

/**
 * Record trace to Observa backend
 */
function recordTrace(
  req: any,
  res: any,
  start: number,
  opts?: ObserveOptions,
  timeToFirstToken?: number | null,
  streamingDuration?: number | null,
  provider?: string,
  traceStarted?: boolean,
  toolsWrapped?: boolean,
  toolCallBuffer?: ToolCallInfo[],
  explicitTraceId?: string | null,
  preCallTools?: any,
  operationName?: string,
): {
  traceId: string | null;
  spanId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  inputCost: number | null;
  outputCost: number | null;
  toolCalls: ToolCallInfo[];
  inputText: string | null;
  outputText: string | null;
} | null {
  const duration = Date.now() - start;
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "vercel-ai.ts:550",
      message: "recordTrace entry",
      data: {
        reqKeys: Object.keys(req),
        resKeys: Object.keys(res),
        duration,
        hasObserva: !!opts?.observa,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "B",
    }),
  }).catch(() => {});
  // #endregion
  try {
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;
    const sanitizedRes = opts?.redact ? opts.redact(res) : res; // Fixed: was using req instead of res

    // CRITICAL: Validate that observa instance is provided
    if (!opts?.observa) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "vercel-ai.ts:560",
            message: "recordTrace: observa instance missing",
            data: {},
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "E",
          }),
        },
      ).catch(() => {});
      // #endregion
      console.error(
        "[Observa] ⚠️ CRITICAL: observa instance not provided to observeVercelAI(). " +
          "Tracking is disabled. Make sure you're using observa.observeVercelAI() " +
          "instead of importing observeVercelAI directly from 'observa-sdk/instrumentation'.",
      );
      return null; // Silently fail (don't crash user's app)
    }

    const trackedModel = resolveModelForTracking(
      sanitizedReq.model,
      sanitizedRes.model,
      req?.model,
    );
    const trackedResponseModel = resolveModelForTracking(
      sanitizedRes.model,
      sanitizedReq.model,
      res?.model,
      trackedModel,
    );
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordTrace",
        message: "resolved models for tracking",
        data: {
          trackedModel,
          trackedResponseModel,
          reqModelType: typeof req?.model,
          resModelType: typeof res?.model,
          sanitizedReqModelType: typeof sanitizedReq?.model,
          sanitizedResModelType: typeof sanitizedRes?.model,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion

    // Extract additional metadata from request (matching Langfuse's OTEL attributes)
    // Helper function to extract metadata from request
    const extractRequestMetadata = (
      req: any,
      trackedModel: string,
      provider?: string,
    ): Record<string, any> => {
      const metadata: Record<string, any> = {};

      // Tools schema (if available)
      if (req.tools) {
        const toolDefinitions = normalizeToolDefinitions(req.tools);
        if (toolDefinitions && toolDefinitions.length > 0) {
          metadata.tools = toolDefinitions;
          metadata["ai.prompt.tools"] = toolDefinitions;
        }
      }

      // Tool choice
      if (req.toolChoice !== undefined) {
        metadata["ai.prompt.toolChoice"] = req.toolChoice;
        metadata.toolChoice = req.toolChoice;
      }

      if (req.experimental_activeTools !== undefined) {
        metadata["ai.prompt.active_tools"] = req.experimental_activeTools;
        metadata.activeTools = req.experimental_activeTools;
      }

      // Settings (maxRetries, etc.)
      if (req.maxRetries !== undefined) {
        metadata["ai.settings.maxRetries"] = String(req.maxRetries);
      }
      if (req.retry !== undefined) {
        metadata["ai.settings.retry"] = req.retry;
      }

      // Additional request parameters
      if (req.topK !== undefined) metadata.topK = req.topK;
      if (req.topP !== undefined) metadata.topP = req.topP;
      if (req.frequencyPenalty !== undefined)
        metadata.frequencyPenalty = req.frequencyPenalty;
      if (req.presencePenalty !== undefined)
        metadata.presencePenalty = req.presencePenalty;
      if (req.stop !== undefined) metadata.stop = req.stop;
      if (req.seed !== undefined) metadata.seed = req.seed;

      // System/gen_ai attributes (matching OTEL format)
      metadata["gen_ai.system"] = provider || "vercel-ai";
      metadata["gen_ai.request.model"] = trackedModel;

      // Operation attributes
      metadata["operation.name"] = "ai.streamText.doStream";
      metadata["ai.operationId"] = "ai.streamText.doStream";
      metadata["ai.model.provider"] = provider || "vercel-ai";
      metadata["ai.model.id"] = trackedModel;

      return metadata;
    };

    const requestMetadata = extractRequestMetadata(
      sanitizedReq,
      trackedModel,
      provider,
    );

    // Extract input text from prompt or messages
    let inputText: string | null = null;
    // #region agent log
    console.log("[Observa DEBUG] recordTrace: sanitizedReq structure:", {
      hasPrompt: !!sanitizedReq.prompt,
      promptType: typeof sanitizedReq.prompt,
      isPromptArray: Array.isArray(sanitizedReq.prompt),
      hasMessages: !!sanitizedReq.messages,
      messagesType: typeof sanitizedReq.messages,
      isMessagesArray: Array.isArray(sanitizedReq.messages),
      messagesLength: Array.isArray(sanitizedReq.messages)
        ? sanitizedReq.messages.length
        : 0,
      firstMessageStructure:
        Array.isArray(sanitizedReq.messages) && sanitizedReq.messages[0]
          ? {
              keys: Object.keys(sanitizedReq.messages[0]),
              hasContent: !!sanitizedReq.messages[0].content,
              contentType: typeof sanitizedReq.messages[0].content,
              isContentArray: Array.isArray(sanitizedReq.messages[0].content),
            }
          : null,
    });
    // #endregion
    if (sanitizedReq.prompt) {
      // Don't treat messages array as prompt - if prompt is an array, it's actually messages
      if (Array.isArray(sanitizedReq.prompt)) {
        // This is actually messages, not prompt
        sanitizedReq.messages = sanitizedReq.prompt;
        sanitizedReq.prompt = null;
      } else {
        inputText =
          typeof sanitizedReq.prompt === "string"
            ? sanitizedReq.prompt
            : safeJsonStringify(sanitizedReq.prompt);
      }
    }
    // Extract only new messages (last user message + any messages after it)
    // This prevents duplicating the full conversation history in each trace
    const allMessages = normalizeMessages(sanitizedReq.messages);
    const inputMessages =
      allMessages.length > 0
        ? extractNewMessages(allMessages)
        : sanitizedReq.prompt
          ? [
              {
                role: "user",
                content: sanitizedReq.prompt,
              },
            ]
          : null;

    if (!inputText && inputMessages) {
      const lastUserMessage = [...inputMessages]
        .reverse()
        .find((m: any) => m?.role === "user");
      inputText = lastUserMessage
        ? extractMessageText(lastUserMessage)
        : inputMessages
            .map((m: any) => extractMessageText(m))
            .filter(Boolean)
            .join("\n");
    }

    const outputMessagesRaw = extractOutputMessages(sanitizedRes);
    const outputText =
      sanitizedRes.text ||
      sanitizedRes.content ||
      extractOutputTextFromMessages(outputMessagesRaw) ||
      null;
    const outputMessages =
      outputMessagesRaw ||
      (outputText
        ? [
            {
              role: "assistant",
              content: outputText,
            },
          ]
        : null);
    // #region agent log
    console.log("[Observa DEBUG] recordTrace: extracted data:", {
      inputText: inputText?.substring(0, 50),
      inputTextLength: inputText?.length,
      outputText: outputText?.substring(0, 50),
      outputTextLength: outputText?.length,
      sanitizedResKeys: Object.keys(sanitizedRes),
      sanitizedReqKeys: Object.keys(sanitizedReq),
    });
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:590",
        message: "recordTrace: extracted data",
        data: {
          inputText: inputText?.substring(0, 50),
          inputTextLength: inputText?.length,
          outputText: outputText?.substring(0, 50),
          outputTextLength: outputText?.length,
          sanitizedResKeys: Object.keys(sanitizedRes),
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion
    // Extract finish reason
    const finishReason = sanitizedRes.finishReason || null;

    const hasToolCallsInMessages = (messages: any): boolean => {
      if (!Array.isArray(messages)) return false;
      return messages.some((message) => {
        if (!message) return false;
        if (message.role === "tool") return true;
        if (message.tool_call_id || message.toolCallId) return true;
        if (
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0
        ) {
          return true;
        }
        if (Array.isArray(message.content)) {
          return message.content.some(
            (item: any) =>
              item?.type === "tool_call" || item?.type === "tool_result",
          );
        }
        return false;
      });
    };

    const hasToolCalls =
      (toolCallBuffer && toolCallBuffer.length > 0) ||
      hasToolCallsInMessages(outputMessages);

    // CRITICAL FIX: Detect empty responses
    const isEmptyResponse =
      !outputText ||
      (typeof outputText === "string" && outputText.trim().length === 0);
    const shouldTreatEmptyAsError = isEmptyResponse && !hasToolCalls;

    // CRITICAL FIX: Detect failure finish reasons
    const isFailureFinishReason =
      finishReason === "content_filter" ||
      finishReason === "length" ||
      finishReason === "max_tokens";

    // If response is empty or has failure finish reason, record as error
    if (shouldTreatEmptyAsError || isFailureFinishReason) {
      // Extract usage
      const usage = sanitizedRes.usage || {};
      const inputTokens = usage.promptTokens || usage.inputTokens || null;
      const outputTokens = usage.completionTokens || usage.outputTokens || null;
      const totalTokens = usage.totalTokens || null;
      const inputCost =
        (usage as any).inputCost ||
        (usage as any).promptCost ||
        (usage as any).input_cost ||
        (usage as any).prompt_cost ||
        null;
      const outputCost =
        (usage as any).outputCost ||
        (usage as any).completionCost ||
        (usage as any).output_cost ||
        (usage as any).completion_cost ||
        null;
      const totalCost =
        (usage as any).totalCost ||
        (usage as any).total_cost ||
        (inputCost || 0) + (outputCost || 0) ||
        null;
      const estimatedCost =
        totalCost === null
          ? estimateCostFromModel(trackedModel, totalTokens)
          : totalCost;

      // Record LLM call with null output to show the attempt
      const errorTraceId =
        explicitTraceId ||
        (opts?.observa?.getCurrentTraceId
          ? opts.observa.getCurrentTraceId()
          : null);
      // Extract metadata for error case too
      const errorMetadata = extractRequestMetadata(
        sanitizedReq,
        trackedModel,
        provider,
      );
      const requestForNormalization = sanitizedReq?.messages
        ? {
            ...sanitizedReq,
            messages: prependSystemMessage(
              sanitizedReq.messages,
              sanitizedReq.system,
            ),
          }
        : sanitizedReq;
      const normalized = buildNormalizedLLMCall({
        request: requestForNormalization,
        response: sanitizedRes,
        provider: provider || "vercel-ai",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        toolDefsOverride: sanitizedReq?.tools ?? preCallTools,
        cost: estimatedCost,
        inputCost,
        outputCost,
      });
      const otelMetadata = buildOtelMetadata(normalized);
      const mergedMetadata = {
        ...errorMetadata,
        ...otelMetadata,
      };
      const systemInstructions = buildSystemInstructions(sanitizedReq?.system);
      const llmSpanId = opts.observa.trackLLMCall({
        model: trackedModel,
        input: inputText,
        output: null, // No output on error
        inputMessages: normalized.inputMessages ?? inputMessages,
        outputMessages: null,
        inputTokens,
        outputTokens,
        totalTokens,
        cost: estimatedCost,
        inputCost,
        outputCost,
        latencyMs: duration,
        timeToFirstTokenMs: timeToFirstToken || null,
        streamingDurationMs: streamingDuration || null,
        finishReason: finishReason,
        responseId: sanitizedRes.responseId || sanitizedRes.id || null,
        operationName: operationName ?? "generate_text",
        providerName: provider || "vercel-ai",
        responseModel:
          trackedResponseModel !== "unknown" ? trackedResponseModel : null,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.maxTokens || sanitizedReq.max_tokens || null,
        systemInstructions: systemInstructions,
        traceId: errorTraceId,
        metadata:
          Object.keys(mergedMetadata).length > 0 ? mergedMetadata : null,
        toolDefinitions:
          normalized.toolDefinitions ?? errorMetadata.tools ?? null,
        tools: normalized.toolDefinitions ?? errorMetadata.tools ?? null,
      });

      // Record error event with appropriate error type
      const errorType = shouldTreatEmptyAsError
        ? "empty_response"
        : finishReason === "content_filter"
          ? "content_filtered"
          : "response_truncated";
      const errorMessage = shouldTreatEmptyAsError
        ? "AI returned empty response"
        : finishReason === "content_filter"
          ? "AI response was filtered due to content policy"
          : "AI response was truncated due to token limit";

      opts.observa.trackError({
        errorType: errorType,
        errorMessage: errorMessage,
        stackTrace: null,
        context: {
          request: sanitizedReq,
          response: sanitizedRes,
          model: trackedModel,
          input: inputText,
          finish_reason: finishReason,
          provider: provider || "vercel-ai",
          duration_ms: duration,
        },
        errorCategory:
          finishReason === "content_filter"
            ? "validation_error"
            : finishReason === "length" || finishReason === "max_tokens"
              ? "model_error"
              : "unknown_error",
        errorCode: shouldTreatEmptyAsError ? "empty_response" : finishReason,
      });

      if (traceStarted && opts?.observa?.endTrace) {
        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "vercel-ai.ts:recordTrace",
              message: "Ending trace after failed response",
              data: {},
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "F",
            }),
          },
        ).catch(() => {});
        // #endregion
        opts.observa.endTrace({ outcome: "error" }).catch(() => {});
      }

      // Don't record as successful trace
      return null;
    }

    // Normal successful response - continue with existing logic
    // Extract usage
    const usage = sanitizedRes.usage || {};
    const usageRaw = (usage as any)?.raw || usage;
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordTrace",
        message: "usage values before mapping",
        data: {
          usageKeys: Object.keys(usage),
          rawKeys:
            usageRaw && typeof usageRaw === "object"
              ? Object.keys(usageRaw)
              : [],
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          totalTokens: usage.totalTokens ?? null,
          promptTokens: usage.promptTokens ?? null,
          completionTokens: usage.completionTokens ?? null,
          rawPromptTokens: usageRaw?.prompt_tokens ?? usageRaw?.promptTokens,
          rawCompletionTokens:
            usageRaw?.completion_tokens ?? usageRaw?.completionTokens,
          rawTotalTokens: usageRaw?.total_tokens ?? usageRaw?.totalTokens,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "H",
      }),
    }).catch(() => {});
    // #endregion
    let inputTokens =
      usage.promptTokens ||
      usage.inputTokens ||
      usageRaw?.prompt_tokens ||
      usageRaw?.input_tokens ||
      usageRaw?.promptTokens ||
      usageRaw?.inputTokens ||
      null;
    let outputTokens =
      usage.completionTokens ||
      usage.outputTokens ||
      usageRaw?.completion_tokens ||
      usageRaw?.output_tokens ||
      usageRaw?.completionTokens ||
      usageRaw?.outputTokens ||
      null;
    let totalTokens =
      usage.totalTokens ||
      usageRaw?.total_tokens ||
      usageRaw?.totalTokens ||
      null;

    if (inputTokens === null && inputText) {
      inputTokens = estimateTokensFromText(inputText);
    }
    if (outputTokens === null && outputText) {
      outputTokens = estimateTokensFromText(outputText);
    }
    if (
      totalTokens === null &&
      (inputTokens !== null || outputTokens !== null)
    ) {
      totalTokens = (inputTokens || 0) + (outputTokens || 0);
    }

    let inputCost =
      usage.inputCost ||
      (usage as any).promptCost ||
      usageRaw?.input_cost ||
      usageRaw?.prompt_cost ||
      usageRaw?.inputCost ||
      null;
    let outputCost =
      usage.outputCost ||
      (usage as any).completionCost ||
      usageRaw?.output_cost ||
      usageRaw?.completion_cost ||
      usageRaw?.outputCost ||
      null;
    let totalCost =
      usage.totalCost || usageRaw?.total_cost || usageRaw?.totalCost || null;
    if (totalCost === null && (inputCost !== null || outputCost !== null)) {
      totalCost = (inputCost || 0) + (outputCost || 0);
    }
    if (totalCost === null) {
      totalCost = estimateCostFromModel(trackedModel, totalTokens);
    }
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordTrace",
        message: "cost estimation inputs",
        data: {
          modelType: typeof (sanitizedReq.model || sanitizedRes.model),
          modelValue:
            typeof (sanitizedReq.model || sanitizedRes.model) === "string"
              ? sanitizedReq.model || sanitizedRes.model
              : null,
          totalTokens,
          totalCost,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "I",
      }),
    }).catch(() => {});
    // #endregion

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:669",
        message: "trackLLMCall call",
        data: {
          input: inputText?.substring(0, 50),
          output: outputText?.substring(0, 50),
          inputTokens,
          outputTokens,
          totalTokens,
          latencyMs: duration,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion
    const resolvedTraceId =
      explicitTraceId ||
      (opts?.observa?.getCurrentTraceId
        ? opts.observa.getCurrentTraceId()
        : null);
    const requestForNormalization = sanitizedReq?.messages
      ? {
          ...sanitizedReq,
          messages: prependSystemMessage(
            sanitizedReq.messages,
            sanitizedReq.system,
          ),
        }
      : sanitizedReq;
    const normalized = buildNormalizedLLMCall({
      request: requestForNormalization,
      response: sanitizedRes,
      provider: provider || "vercel-ai",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens,
      },
      toolDefsOverride: sanitizedReq?.tools ?? preCallTools,
      cost: totalCost,
      inputCost,
      outputCost,
    });
    const otelMetadata = buildOtelMetadata(normalized);
    const mergedMetadata = {
      ...requestMetadata,
      ...otelMetadata,
    };
    const systemInstructions = buildSystemInstructions(sanitizedReq?.system);
    const llmSpanId = opts.observa.trackLLMCall({
      model: trackedModel,
      input: inputText,
      output: outputText,
      inputMessages: normalized.inputMessages ?? inputMessages,
      outputMessages: normalized.outputMessages ?? outputMessages,
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs: duration,
      timeToFirstTokenMs: timeToFirstToken || null,
      streamingDurationMs: streamingDuration || null,
      finishReason: finishReason,
      responseId: sanitizedRes.responseId || sanitizedRes.id || null,
      operationName: operationName ?? "generate_text",
      providerName: provider || "vercel-ai",
      responseModel:
        trackedResponseModel !== "unknown" ? trackedResponseModel : null,
      temperature: sanitizedReq.temperature || null,
      maxTokens: sanitizedReq.maxTokens || sanitizedReq.max_tokens || null,
      systemInstructions: systemInstructions,
      cost: totalCost,
      inputCost,
      outputCost,
      traceId: resolvedTraceId,
      metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : null,
      toolDefinitions:
        normalized.toolDefinitions ?? requestMetadata.tools ?? null,
      tools: normalized.toolDefinitions ?? requestMetadata.tools ?? null,
    });

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordTrace",
        message: "trace id resolution",
        data: {
          explicitTraceId,
          resolvedTraceId,
          hasGetCurrentTraceId: !!opts?.observa?.getCurrentTraceId,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "K",
      }),
    }).catch(() => {});
    // #endregion

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordTrace",
        message: "llm_call payload summary",
        data: {
          inputLength: inputText?.length || 0,
          outputLength: outputText?.length || 0,
          inputTokens,
          outputTokens,
          totalTokens,
          cost: totalCost,
          inputCost,
          outputCost,
          toolBufferCount: (toolCallBuffer || []).length,
          resolvedTraceId,
          llmSpanId,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion

    if (opts?.onLLMSpan) {
      opts.onLLMSpan({
        traceId: resolvedTraceId,
        spanId: llmSpanId,
        responseId: sanitizedRes.responseId || sanitizedRes.id || null,
        model:
          trackedResponseModel !== "unknown"
            ? trackedResponseModel
            : trackedModel,
      });
    }

    const bufferedToolCalls = toolCallBuffer || [];
    const responseToolCalls = !toolsWrapped
      ? extractToolCallsFromResponse(sanitizedRes)
      : [];
    const traceId = resolvedTraceId;
    const toolCalls = [...bufferedToolCalls, ...responseToolCalls];
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordTrace",
        message: "tool_calls emitted",
        data: {
          bufferedCount: bufferedToolCalls.length,
          responseCount: responseToolCalls.length,
          totalCount: toolCalls.length,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "C",
      }),
    }).catch(() => {});
    // #endregion
    for (const call of toolCalls) {
      opts.observa.trackToolCall({
        toolName: call.toolName,
        args: call.args,
        result: call.result,
        resultStatus: call.resultStatus,
        latencyMs: call.latencyMs ?? duration,
        errorMessage: call.errorMessage,
        toolCallId: call.toolCallId ?? null,
        parentSpanId: llmSpanId,
        traceId,
      });
    }

    if (traceStarted && opts?.observa?.endTrace) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "vercel-ai.ts:recordTrace",
            message: "Ending trace after successful response",
            data: {},
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "F",
          }),
        },
      ).catch(() => {});
      // #endregion
      opts.observa.endTrace({ outcome: "success" }).catch(() => {});
    }

    return {
      traceId: resolvedTraceId,
      spanId: llmSpanId,
      inputTokens,
      outputTokens,
      totalTokens,
      cost: totalCost,
      inputCost,
      outputCost,
      toolCalls,
      inputText,
      outputText,
    };
  } catch (e) {
    console.error("[Observa] Failed to record trace", e);
  }
  return null;
}

/**
 * Record error to Observa backend
 * Creates both an LLM call span (so users can see what failed) and an error event
 */
function recordError(
  req: any,
  error: any,
  start: number,
  opts?: ObserveOptions,
  provider?: string,
  preExtractedInputText?: string | null,
  preExtractedInputMessages?: any,
  traceStarted?: boolean,
  toolCallBuffer?: ToolCallInfo[],
  explicitTraceId?: string | null,
  preCallTools?: any,
) {
  const duration = Date.now() - start;

  try {
    console.error("[Observa] ⚠️ Error Captured:", error?.message || error);
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;

    // CRITICAL: Validate that observa instance is provided
    if (!opts?.observa) {
      console.error(
        "[Observa] ⚠️ CRITICAL: observa instance not provided to observeVercelAI(). " +
          "Error tracking is disabled. Make sure you're using observa.observeVercelAI() " +
          "instead of importing observeVercelAI directly from 'observa-sdk/instrumentation'.",
      );
      return; // Silently fail (don't crash user's app)
    }

    // Use pre-extracted model identifier if available, otherwise extract from request
    const trackedModel = resolveModelForTracking(
      sanitizedReq.model,
      req?.model,
    );
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "vercel-ai.ts:recordError",
        message: "resolved model for error tracking",
        data: {
          trackedModel,
          reqModelType: typeof req?.model,
          sanitizedReqModelType: typeof sanitizedReq?.model,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "C",
      }),
    }).catch(() => {});
    // #endregion

    // Use pre-extracted input text if available (extracted before operation), otherwise extract now
    let inputText: string | null = preExtractedInputText || null;
    let inputMessages: any = preExtractedInputMessages || null;

    if (!inputText) {
      // Fallback: Extract input text from prompt or messages
      if (sanitizedReq.prompt) {
        inputText =
          typeof sanitizedReq.prompt === "string"
            ? sanitizedReq.prompt
            : safeJsonStringify(sanitizedReq.prompt);
      } else if (sanitizedReq.messages) {
        // Extract only new messages (last user message + any messages after it)
        // This prevents duplicating the full conversation history in each trace
        const normalizedMessages = normalizeMessages(sanitizedReq.messages);
        inputMessages = extractNewMessages(normalizedMessages);
        // But still extract full text from all messages for inputText (for token counting)
        inputText = normalizedMessages
          .map((m: any) => {
            // Handle string content
            if (typeof m.content === "string") return m.content;
            // Handle array content (e.g., [{type: "text", text: "..."}])
            if (Array.isArray(m.content)) {
              return m.content
                .map((c: any) => (typeof c === "string" ? c : c.text || c.type))
                .filter(Boolean)
                .join("\n");
            }
            // Fallback to text property or empty string
            return m.text || "";
          })
          .filter(Boolean)
          .join("\n");
      }
    }

    // Extract error information using error utilities
    const providerName = provider || "vercel-ai";
    const extractedError = extractProviderError(error, providerName);

    // Extract additional metadata from request (matching Langfuse's OTEL attributes)
    const extractRequestMetadata = (
      req: any,
      trackedModel: string,
      provider?: string,
    ): Record<string, any> => {
      const metadata: Record<string, any> = {};

      // Tools schema (if available)
      if (req.tools) {
        const toolDefinitions = normalizeToolDefinitions(req.tools);
        if (toolDefinitions && toolDefinitions.length > 0) {
          metadata.tools = toolDefinitions;
          metadata["ai.prompt.tools"] = toolDefinitions;
        }
      }

      // Tool choice
      if (req.toolChoice !== undefined) {
        metadata["ai.prompt.toolChoice"] = req.toolChoice;
        metadata.toolChoice = req.toolChoice;
      }

      if (req.experimental_activeTools !== undefined) {
        metadata["ai.prompt.active_tools"] = req.experimental_activeTools;
        metadata.activeTools = req.experimental_activeTools;
      }

      // Settings (maxRetries, etc.)
      if (req.maxRetries !== undefined) {
        metadata["ai.settings.maxRetries"] = String(req.maxRetries);
      }
      if (req.retry !== undefined) {
        metadata["ai.settings.retry"] = req.retry;
      }

      // Additional request parameters
      if (req.topK !== undefined) metadata.topK = req.topK;
      if (req.topP !== undefined) metadata.topP = req.topP;
      if (req.frequencyPenalty !== undefined)
        metadata.frequencyPenalty = req.frequencyPenalty;
      if (req.presencePenalty !== undefined)
        metadata.presencePenalty = req.presencePenalty;
      if (req.stop !== undefined) metadata.stop = req.stop;
      if (req.seed !== undefined) metadata.seed = req.seed;

      // System/gen_ai attributes (matching OTEL format)
      metadata["gen_ai.system"] = provider || "vercel-ai";
      metadata["gen_ai.request.model"] = trackedModel;

      // Operation attributes
      metadata["operation.name"] = "ai.streamText.doStream";
      metadata["ai.operationId"] = "ai.streamText.doStream";
      metadata["ai.model.provider"] = provider || "vercel-ai";
      metadata["ai.model.id"] = trackedModel;

      return metadata;
    };

    // Create LLM call span with error information so users can see what failed
    // This provides context: model, input, and that it failed
    const errorTraceId =
      explicitTraceId ||
      (opts?.observa?.getCurrentTraceId
        ? opts.observa.getCurrentTraceId()
        : null);
    // Extract metadata for error case
    const errorMetadata = extractRequestMetadata(
      sanitizedReq,
      trackedModel,
      providerName,
    );
    const requestForNormalization = sanitizedReq?.messages
      ? {
          ...sanitizedReq,
          messages: prependSystemMessage(
            sanitizedReq.messages,
            sanitizedReq.system,
          ),
        }
      : sanitizedReq;
    const normalized = buildNormalizedLLMCall({
      request: requestForNormalization,
      provider: providerName,
      toolDefsOverride: sanitizedReq?.tools ?? preCallTools,
    });
    const otelMetadata = buildOtelMetadata(normalized);
    const mergedMetadata = {
      ...errorMetadata,
      ...otelMetadata,
    };
    const systemInstructions = buildSystemInstructions(sanitizedReq?.system);
    const llmSpanId = opts.observa.trackLLMCall({
      model: trackedModel,
      input: inputText,
      output: null, // No output on error
      inputMessages: normalized.inputMessages ?? inputMessages,
      outputMessages: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      latencyMs: duration,
      timeToFirstTokenMs: null,
      streamingDurationMs: null,
      finishReason: null,
      responseId: null,
      operationName: "generate_text",
      providerName: providerName,
      responseModel: trackedModel !== "unknown" ? trackedModel : null,
      temperature: sanitizedReq.temperature || null,
      maxTokens: sanitizedReq.maxTokens || sanitizedReq.max_tokens || null,
      systemInstructions: systemInstructions,
      traceId: errorTraceId,
      metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : null,
      toolDefinitions:
        normalized.toolDefinitions ?? errorMetadata.tools ?? null,
      tools: normalized.toolDefinitions ?? errorMetadata.tools ?? null,
    });

    if (toolCallBuffer && toolCallBuffer.length > 0) {
      const traceId = errorTraceId;
      for (const call of toolCallBuffer) {
        opts.observa.trackToolCall({
          toolName: call.toolName,
          args: call.args,
          result: call.result,
          resultStatus: call.resultStatus,
          latencyMs: call.latencyMs ?? duration,
          errorMessage: call.errorMessage,
          toolCallId: call.toolCallId ?? null,
          parentSpanId: llmSpanId,
          traceId,
        });
      }
    }

    // Also create error event with full context and extracted error codes/categories
    opts.observa.trackError({
      errorType: error?.name || extractedError.code || "UnknownError",
      errorMessage: extractedError.message,
      stackTrace: error?.stack || null,
      context: {
        request: sanitizedReq,
        model: trackedModel,
        input: inputText,
        provider: providerName,
        duration_ms: duration,
        status_code: extractedError.statusCode || null,
      },
      errorCategory: extractedError.category,
      errorCode: extractedError.code,
    });

    if (traceStarted && opts?.observa?.endTrace) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "vercel-ai.ts:recordError",
            message: "Ending trace after error",
            data: {},
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "F",
          }),
        },
      ).catch(() => {});
      // #endregion
      opts.observa.endTrace({ outcome: "error" }).catch(() => {});
    }
  } catch (e) {
    // Ignore errors in error handling
    console.error("[Observa] Failed to record error", e);
  }
}

/** Trace a generateObject call (structured output) */
async function traceGenerateObject(
  originalFn: (...args: any[]) => Promise<any>,
  args: any[],
  options?: ObserveOptions,
) {
  const startTime = Date.now();
  const requestParams =
    typeof args[0] === "object" && args[0] !== null ? args[0] : {};
  const model = requestParams.model || "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);
  let traceStarted = false;
  let startedTraceId: string | null = null;
  const hasActiveTraceFn =
    typeof options?.observa?.hasActiveTrace === "function";
  const hasActiveTrace = hasActiveTraceFn
    ? options!.observa.hasActiveTrace()
    : false;
  const existingTraceId =
    options?.observa?.getCurrentTraceId &&
    typeof options.observa.getCurrentTraceId === "function"
      ? options.observa.getCurrentTraceId()
      : null;
  if (hasActiveTraceFn && !hasActiveTrace) {
    startedTraceId = options!.observa.startTrace({ name: options?.name });
    traceStarted = true;
  }
  const traceIdForRequest = startedTraceId || existingTraceId;
  let inputText: string | null = null;
  if (requestParams.prompt) {
    inputText =
      typeof requestParams.prompt === "string"
        ? requestParams.prompt
        : safeJsonStringify(requestParams.prompt);
  } else if (requestParams.messages) {
    const normalized = normalizeMessages(requestParams.messages);
    inputText = normalized
      .map((m: any) => extractMessageText(m))
      .filter(Boolean)
      .join("\n");
  }
  try {
    const result = await originalFn(...args);
    const outputObj = result.object ?? result;
    const outputText =
      typeof outputObj === "string" ? outputObj : safeJsonStringify(outputObj);
    const usage = await resolveUsageFromResult(result);
    const responseModel = result.model
      ? extractModelIdentifier(result.model)
      : modelIdentifier;
    const syntheticRes = {
      text: outputText,
      usage,
      finishReason: result.finishReason ?? "stop",
      responseId: result.response?.id ?? null,
      model: responseModel,
      messages: null,
    };
    const traceInfo = recordTrace(
      requestParams,
      syntheticRes,
      startTime,
      options,
      null,
      null,
      provider,
      traceStarted,
      false,
      [],
      traceIdForRequest,
      null,
      "structured_output",
    );
    if (traceInfo && result) {
      attachFeedbackHelpers(
        result,
        {
          traceId: traceInfo.traceId,
          spanId: traceInfo.spanId,
          responseId: syntheticRes.responseId,
          model: responseModel,
        },
        options,
      );
      attachResultMetadata(result, traceInfo);
    }
    return result;
  } catch (error) {
    recordError(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt ?? null,
        messages: requestParams.messages ?? null,
        temperature: requestParams.temperature ?? null,
        maxTokens: requestParams.maxTokens ?? requestParams.max_tokens ?? null,
      },
      error as Error,
      startTime,
      options,
      provider,
      inputText ?? null,
      null,
      traceStarted,
      [],
      traceIdForRequest,
      null,
    );
    throw error;
  }
}

/** Trace a streamObject call (streaming structured output) */
async function traceStreamObject(
  originalFn: (...args: any[]) => Promise<any>,
  args: any[],
  options?: ObserveOptions,
) {
  const startTime = Date.now();
  const requestParams =
    typeof args[0] === "object" && args[0] !== null ? args[0] : {};
  const model = requestParams.model || "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);
  let traceStarted = false;
  let startedTraceId: string | null = null;
  const hasActiveTraceFn =
    typeof options?.observa?.hasActiveTrace === "function";
  const hasActiveTrace = hasActiveTraceFn
    ? options!.observa.hasActiveTrace()
    : false;
  const existingTraceId =
    options?.observa?.getCurrentTraceId &&
    typeof options.observa.getCurrentTraceId === "function"
      ? options.observa.getCurrentTraceId()
      : null;
  if (hasActiveTraceFn && !hasActiveTrace) {
    startedTraceId = options!.observa.startTrace({ name: options?.name });
    traceStarted = true;
  }
  const traceIdForRequest = startedTraceId || existingTraceId;
  let inputText: string | null = null;
  if (requestParams.prompt) {
    inputText =
      typeof requestParams.prompt === "string"
        ? requestParams.prompt
        : safeJsonStringify(requestParams.prompt);
  } else if (requestParams.messages) {
    const normalized = normalizeMessages(requestParams.messages);
    inputText = normalized
      .map((m: any) => extractMessageText(m))
      .filter(Boolean)
      .join("\n");
  }
  try {
    const result = await originalFn(...args);
    const stream =
      result.partialObjectStream ?? result.objectStream ?? result.stream;
    if (stream && typeof stream[Symbol.asyncIterator] === "function") {
      const collected: any[] = [];
      const requestParamsCopy = requestParams;
      const startTimeCopy = startTime;
      const optionsCopy = options;
      const providerCopy = provider;
      const traceStartedCopy = traceStarted;
      const traceIdForRequestCopy = traceIdForRequest;
      result.partialObjectStream = (async function* () {
        for await (const value of stream) {
          collected.push(value);
          yield value;
        }
        const lastValue =
          collected.length > 0 ? collected[collected.length - 1] : null;
        const outputText =
          lastValue != null
            ? typeof lastValue === "string"
              ? lastValue
              : safeJsonStringify(lastValue)
            : "";
        waitUntil(
          (async () => {
            try {
              const usage = await resolveUsageFromResult(result);
              const responseModel = result.model
                ? extractModelIdentifier(result.model)
                : modelIdentifier;
              const syntheticRes = {
                text: outputText,
                usage,
                finishReason: "stop",
                responseId: null,
                model: responseModel,
                messages: null,
              };
              recordTrace(
                requestParamsCopy,
                syntheticRes,
                startTimeCopy,
                optionsCopy,
                null,
                null,
                providerCopy,
                traceStartedCopy,
                false,
                [],
                traceIdForRequestCopy,
                null,
                "structured_output",
              );
            } catch (e) {
              console.error("[Observa] streamObject trace callback error", e);
            }
          })(),
        );
      })();
    }
    return result;
  } catch (error) {
    recordError(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt ?? null,
        messages: requestParams.messages ?? null,
        temperature: requestParams.temperature ?? null,
        maxTokens: requestParams.maxTokens ?? requestParams.max_tokens ?? null,
      },
      error as Error,
      startTime,
      options,
      provider,
      inputText ?? null,
      null,
      traceStarted,
      [],
      traceIdForRequest,
      null,
    );
    throw error;
  }
}

/** Trace an embed call (single embedding) */
async function traceEmbed(
  originalFn: (...args: any[]) => Promise<any>,
  args: any[],
  options?: ObserveOptions,
) {
  const startTime = Date.now();
  const requestParams =
    typeof args[0] === "object" && args[0] !== null ? args[0] : {};
  const model = requestParams.model ?? "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);
  let traceStarted = false;
  const hasActiveTraceFn =
    typeof options?.observa?.hasActiveTrace === "function";
  if (hasActiveTraceFn && !options!.observa.hasActiveTrace()) {
    options!.observa.startTrace({ name: options?.name });
    traceStarted = true;
  }
  try {
    const result = await originalFn(...args);
    const latencyMs = Date.now() - startTime;
    const embedding = result.embedding ?? result;
    const embeddingArray = Array.isArray(embedding)
      ? embedding
      : typeof embedding === "object" &&
          embedding !== null &&
          "embedding" in embedding
        ? (embedding as any).embedding
        : null;
    if (
      options?.observa?.trackEmbedding &&
      embeddingArray &&
      Array.isArray(embeddingArray)
    ) {
      options.observa.trackEmbedding({
        model: modelIdentifier,
        dimensionCount: embeddingArray.length,
        latencyMs,
        providerName: provider,
        embeddings: [embeddingArray],
        inputText:
          typeof requestParams.input === "string"
            ? requestParams.input
            : Array.isArray(requestParams.input)
              ? requestParams.input.join("\n")
              : null,
      });
    }
    if (traceStarted && options?.observa?.endTrace)
      options.observa.endTrace({ outcome: "success" }).catch(() => {});
    return result;
  } catch (error) {
    if (options?.observa?.trackError) {
      options.observa.trackError({
        errorType: (error as Error).name ?? "Error",
        errorMessage: (error as Error).message,
        stackTrace: (error as Error).stack ?? null,
        errorCategory: "embedding_error",
        errorCode: "embedding_failed",
      });
    }
    if (traceStarted && options?.observa?.endTrace)
      options.observa.endTrace({ outcome: "error" }).catch(() => {});
    throw error;
  }
}

/** Trace an embedMany call (batch embeddings) */
async function traceEmbedMany(
  originalFn: (...args: any[]) => Promise<any>,
  args: any[],
  options?: ObserveOptions,
) {
  const startTime = Date.now();
  const requestParams =
    typeof args[0] === "object" && args[0] !== null ? args[0] : {};
  const model = requestParams.model ?? "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);
  let traceStarted = false;
  const hasActiveTraceFn =
    typeof options?.observa?.hasActiveTrace === "function";
  if (hasActiveTraceFn && !options!.observa.hasActiveTrace()) {
    options!.observa.startTrace({ name: options?.name });
    traceStarted = true;
  }
  try {
    const result = await originalFn(...args);
    const latencyMs = Date.now() - startTime;
    const embeddings =
      result.embeddings ?? (result.embedding ? [result.embedding] : []);
    const arr = Array.isArray(embeddings) ? embeddings : [];
    if (options?.observa?.trackEmbedding && arr.length > 0) {
      const first = arr[0];
      const dimensionCount = Array.isArray(first) ? first.length : 0;
      options.observa.trackEmbedding({
        model: modelIdentifier,
        dimensionCount: dimensionCount || null,
        latencyMs,
        providerName: provider,
        embeddings: arr,
        inputText: Array.isArray(requestParams.input)
          ? requestParams.input.join("\n")
          : typeof requestParams.input === "string"
            ? requestParams.input
            : null,
      });
    }
    if (traceStarted && options?.observa?.endTrace)
      options.observa.endTrace({ outcome: "success" }).catch(() => {});
    return result;
  } catch (error) {
    if (options?.observa?.trackError) {
      options.observa.trackError({
        errorType: (error as Error).name ?? "Error",
        errorMessage: (error as Error).message,
        stackTrace: (error as Error).stack ?? null,
        errorCategory: "embedding_error",
        errorCode: "embedding_failed",
      });
    }
    if (traceStarted && options?.observa?.endTrace)
      options.observa.endTrace({ outcome: "error" }).catch(() => {});
    throw error;
  }
}

/**
 * Observe Vercel AI SDK - wraps generateText, streamText, generateObject, streamObject, embed, embedMany
 *
 * @param aiSdk - Vercel AI SDK module (imported from 'ai')
 * @param options - Observation options (name, tags, userId, sessionId, redact)
 * @returns Wrapped AI SDK with automatic tracing
 *
 * @example
 * ```typescript
 * import { generateText, streamText } from 'ai';
 * import { observeVercelAI } from 'observa-sdk/instrumentation';
 *
 * const ai = observeVercelAI({ generateText, streamText }, {
 *   name: 'my-app',
 *   redact: (data) => ({ ...data, prompt: '[REDACTED]' })
 * });
 *
 * // Use wrapped functions - automatically tracked!
 * const result = await ai.generateText({
 *   model: 'openai/gpt-4',
 *   prompt: 'Hello!'
 * });
 * ```
 */
export function observeVercelAI(
  aiSdk: {
    generateText?: GenerateTextFn;
    streamText?: StreamTextFn;
    [key: string]: any;
  },
  options?: ObserveOptions,
): {
  generateText?: GenerateTextFn;
  streamText?: StreamTextFn;
  [key: string]: any;
} {
  try {
    // CRITICAL: Warn if observa instance is not provided
    // This is the most common mistake - users importing observeVercelAI directly
    if (!options?.observa) {
      console.error(
        "[Observa] ⚠️ CRITICAL ERROR: observa instance not provided!\n" +
          "\n" +
          "Tracking will NOT work. You must use observa.observeVercelAI() instead.\n" +
          "\n" +
          "❌ WRONG (importing directly):\n" +
          "  import { observeVercelAI } from 'observa-sdk/instrumentation';\n" +
          "  const ai = observeVercelAI({ generateText, streamText });\n" +
          "\n" +
          "✅ CORRECT (using instance method):\n" +
          "  import { init } from 'observa-sdk';\n" +
          "  const observa = init({ apiKey: '...' });\n" +
          "  const ai = observa.observeVercelAI({ generateText, streamText });\n",
      );
    }

    const wrapped: any = { ...aiSdk };

    // Wrap generateText if available
    if (aiSdk.generateText && typeof aiSdk.generateText === "function") {
      wrapped.generateText = async function (...args: any[]) {
        return traceGenerateText(
          aiSdk.generateText!.bind(aiSdk),
          args,
          options,
        );
      };
    }

    // Wrap streamText if available
    if (aiSdk.streamText && typeof aiSdk.streamText === "function") {
      wrapped.streamText = async function (...args: any[]) {
        return traceStreamText(aiSdk.streamText!.bind(aiSdk), args, options);
      };
    }

    // Wrap generateObject if available
    if (aiSdk.generateObject && typeof aiSdk.generateObject === "function") {
      wrapped.generateObject = async function (...args: any[]) {
        return traceGenerateObject(
          aiSdk.generateObject!.bind(aiSdk),
          args,
          options,
        );
      };
    }

    // Wrap streamObject if available
    if (aiSdk.streamObject && typeof aiSdk.streamObject === "function") {
      wrapped.streamObject = async function (...args: any[]) {
        return traceStreamObject(
          aiSdk.streamObject!.bind(aiSdk),
          args,
          options,
        );
      };
    }

    // Wrap embed if available
    if (aiSdk.embed && typeof aiSdk.embed === "function") {
      wrapped.embed = async function (...args: any[]) {
        return traceEmbed(aiSdk.embed!.bind(aiSdk), args, options);
      };
    }

    // Wrap embedMany if available
    if (aiSdk.embedMany && typeof aiSdk.embedMany === "function") {
      wrapped.embedMany = async function (...args: any[]) {
        return traceEmbedMany(aiSdk.embedMany!.bind(aiSdk), args, options);
      };
    }

    // Pass through other exports unchanged
    return wrapped;
  } catch (error) {
    // Fail gracefully - return unwrapped SDK
    console.error("[Observa] Failed to wrap Vercel AI SDK:", error);
    return aiSdk;
  }
}
