/**
 * Anthropic SDK Wrapper
 *
 * Implements observeAnthropic() following same pattern as OpenAI wrapper.
 * Uses Proxy with WeakMap memoization to preserve object identity.
 * Handles streaming with proper teeing (preserves TTFT).
 * Includes PII redaction hooks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { wrapStream } from "./utils";
import { mapAnthropicToOTEL, OTEL_SEMCONV } from "./semconv";
import { buildNormalizedLLMCall, buildOtelMetadata } from "./normalize";
import { getTraceContext, waitUntil } from "../context";
import { extractProviderError } from "./error-utils";

// Type for Anthropic client (avoid direct import to handle optional dependency)
type Anthropic = any;

// WeakMap Cache for Memoization (CRITICAL for object identity)
const proxyCache = new WeakMap<object, any>();

export interface ObserveOptions {
  name?: string;
  tags?: string[];
  userId?: string;
  sessionId?: string;
  // Callback to scrub PII before sending to Observa
  redact?: (data: any) => any;
  // Observa instance for sending events
  observa?: any; // Observa class instance
}

/**
 * Observe Anthropic client - wraps client with automatic tracing
 *
 * @param client - Anthropic client instance
 * @param options - Observation options (name, tags, userId, sessionId, redact)
 * @returns Wrapped Anthropic client (same instance reference preserved via WeakMap)
 *
 * @example
 * ```typescript
 * import Anthropic from '@anthropic-ai/sdk';
 * import { observeAnthropic } from 'observa-sdk/instrumentation';
 *
 * const client = new Anthropic({ apiKey: '...' });
 * const wrapped = observeAnthropic(client, {
 *   name: 'my-app',
 *   redact: (data) => ({ ...data, messages: '[REDACTED]' })
 * });
 *
 * // Use wrapped client - automatically tracked!
 * await wrapped.messages.create({ ... });
 * ```
 */
export function observeAnthropic(
  client: Anthropic,
  options?: ObserveOptions,
): Anthropic {
  // Return cached proxy if exists to maintain identity (client === client)
  if (proxyCache.has(client)) {
    return proxyCache.get(client);
  }

  // CRITICAL: Warn if observa instance is not provided
  // This is the most common mistake - users importing observeAnthropic directly
  if (!options?.observa) {
    console.error(
      "[Observa] ⚠️ CRITICAL ERROR: observa instance not provided!\n" +
        "\n" +
        "Tracking will NOT work. You must use observa.observeAnthropic() instead.\n" +
        "\n" +
        "❌ WRONG (importing directly):\n" +
        "  import { observeAnthropic } from 'observa-sdk/instrumentation';\n" +
        "  const wrapped = observeAnthropic(anthropic);\n" +
        "\n" +
        "✅ CORRECT (using instance method):\n" +
        "  import { init } from 'observa-sdk';\n" +
        "  const observa = init({ apiKey: '...' });\n" +
        "  const wrapped = observa.observeAnthropic(anthropic);\n",
    );
  }

  try {
    const wrapped = new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        // Recursive wrapping for nested objects (like client.messages)
        if (typeof value === "object" && value !== null) {
          // Don't wrap internal prototypes
          if (prop === "prototype" || prop === "constructor") {
            return value;
          }

          // Recursive wrap with same options (memoized via proxyCache)
          return observeAnthropic(value as any, options);
        }

        // Intercept the specific function call: messages.create
        if (typeof value === "function" && prop === "create") {
          // We assume we are at the leaf node (messages.create)
          return async function (...args: any[]) {
            return traceAnthropicCall(value.bind(target), args, options);
          };
        }

        return value;
      },
    });

    // Cache the proxy to preserve object identity
    proxyCache.set(client, wrapped);
    return wrapped;
  } catch (error) {
    // Fail gracefully - never crash user's app
    console.error("[Observa] Failed to wrap Anthropic client:", error);
    return client; // Return unwrapped client - user code still works
  }
}

/**
 * Trace an Anthropic API call
 */
async function traceAnthropicCall(
  originalFn: Function,
  args: any[],
  options?: ObserveOptions,
) {
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const isStreaming = requestParams.stream === true;
  const preCallTools = requestParams?.tools ?? null;

  // Extract input text early (before operation starts) to ensure it's captured even on errors
  const inputText =
    requestParams.messages
      ?.map((m: any) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .map((c: any) => c.text || c.type)
            .filter(Boolean)
            .join("\n");
        }
        return null;
      })
      .filter(Boolean)
      .join("\n") || null;
  const inputMessages = requestParams.messages || null;
  const model = requestParams.model || "unknown";

  try {
    // 1. Execute Original Call
    const result = await originalFn(...args);

    // 2. Handle Streaming vs Blocking
    if (isStreaming) {
      // Wrap stream to capture data without blocking TTFT
      return wrapStream(
        result,
        (fullResponse: any) => {
          // Stream completed -> Send Trace to Observa
          recordTrace(
            requestParams,
            fullResponse,
            startTime,
            options,
            fullResponse.timeToFirstToken,
            fullResponse.streamingDuration,
            preCallTools,
          );
        },
        (err: any) =>
          recordError(
            requestParams,
            err,
            startTime,
            options,
            inputText,
            inputMessages,
            model,
            preCallTools,
          ),
        "anthropic",
      );
    } else {
      // Standard await -> Send Trace to Observa
      recordTrace(
        requestParams,
        result,
        startTime,
        options,
        undefined,
        undefined,
        preCallTools,
      );
      return result;
    }
  } catch (error) {
    recordError(
      requestParams,
      error,
      startTime,
      options,
      inputText,
      inputMessages,
      model,
      preCallTools,
    );
    throw error; // Always re-throw user errors
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
  preCallTools?: any,
) {
  const duration = Date.now() - start;

  // Defensive: Ensure Observa never crashes the app
  try {
    const context = getTraceContext();

    // Sanitize data with redact hook if provided
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;
    const sanitizedRes = opts?.redact ? opts.redact(res) : res;

    // CRITICAL: Validate that observa instance is provided
    if (!opts?.observa) {
      console.error(
        "[Observa] ⚠️ CRITICAL: observa instance not provided to observeAnthropic(). " +
          "Tracking is disabled. Make sure you're using observa.observeAnthropic() " +
          "instead of importing observeAnthropic directly from 'observa-sdk/instrumentation'.",
      );
      return; // Silently fail (don't crash user's app)
    }

    // Use Observa instance if provided
    if (opts.observa) {
      const normalized = buildNormalizedLLMCall({
        request: sanitizedReq,
        response: sanitizedRes,
        provider: "anthropic",
        toolDefsOverride: sanitizedReq?.tools ?? preCallTools,
      });
      const toolDefinitions = normalized.toolDefinitions;
      const otelMetadata = buildOtelMetadata(normalized);
      // Extract input text from messages
      const inputText =
        sanitizedReq.messages
          ?.map((m: any) => {
            if (typeof m.content === "string") return m.content;
            if (Array.isArray(m.content)) {
              return m.content
                .map((c: any) => c.text || c.type)
                .filter(Boolean)
                .join("\n");
            }
            return null;
          })
          .filter(Boolean)
          .join("\n") || null;

      // Extract output text from response (exclude thinking blocks for main output)
      const contentBlocks = sanitizedRes?.content ?? [];
      const outputText =
        contentBlocks
          .filter((c: any) => c.type !== "thinking")
          .map((c: any) => c.text)
          .filter(Boolean)
          .join("\n") || null;

      // Extract extended thinking blocks (Anthropic extended thinking / chain-of-thought)
      const thinkingBlocks = contentBlocks
        .filter((c: any) => c.type === "thinking")
        .map(
          (c: any) =>
            c.thinking ??
            c.text ??
            (typeof c.content === "string" ? c.content : null),
        )
        .filter(Boolean);
      const hasThinking = thinkingBlocks.length > 0;

      // Extract tool_use blocks (including computer use) for metadata
      const toolUseBlocks = contentBlocks
        .filter((c: any) => c.type === "tool_use" || c.type === "tool use")
        .map((c: any) => ({
          id: c.id,
          name: c.name,
          input: c.input,
          type: c.type,
        }));
      const hasComputerUse = toolUseBlocks.some(
        (t: any) =>
          t.name === "computer" ||
          t.name === "computer_use" ||
          (t.name && String(t.name).toLowerCase().includes("computer")),
      );

      // Merge reasoning/computer-use into metadata for observability
      const enrichedMetadata = {
        ...otelMetadata,
        ...(hasThinking
          ? {
              anthropic_thinking:
                thinkingBlocks.length <= 5
                  ? thinkingBlocks
                  : thinkingBlocks.slice(0, 5).concat(["[truncated]"]),
              reasoning_step_count: thinkingBlocks.length,
            }
          : {}),
        ...(hasComputerUse || toolUseBlocks.length > 0
          ? {
              anthropic_tool_use_blocks:
                toolUseBlocks.length <= 10
                  ? toolUseBlocks
                  : toolUseBlocks.slice(0, 10),
            }
          : {}),
      };

      // Extract stop reason (Anthropic's equivalent of finish_reason)
      const stopReason = sanitizedRes?.stop_reason || null;

      // CRITICAL FIX: Detect empty responses
      const isEmptyResponse =
        !outputText ||
        (typeof outputText === "string" && outputText.trim().length === 0);

      // CRITICAL FIX: Detect failure stop reasons (Anthropic uses stop_sequence for content filter, max_tokens for length)
      const isFailureStopReason =
        stopReason === "stop_sequence" || stopReason === "max_tokens";

      // If response is empty or has failure stop reason, record as error
      if (isEmptyResponse || isFailureStopReason) {
        // Record LLM call with null output to show the attempt
        opts.observa.trackLLMCall({
          model: sanitizedReq.model || sanitizedRes?.model || "unknown",
          input: inputText,
          output: null, // No output on error
          inputMessages: normalized.inputMessages,
          outputMessages: normalized.outputMessages,
          inputTokens: sanitizedRes?.usage?.input_tokens || null,
          outputTokens: sanitizedRes?.usage?.output_tokens || null,
          totalTokens:
            (sanitizedRes?.usage?.input_tokens || 0) +
              (sanitizedRes?.usage?.output_tokens || 0) || null,
          latencyMs: duration,
          timeToFirstTokenMs: timeToFirstToken || null,
          streamingDurationMs: streamingDuration || null,
          finishReason: stopReason,
          responseId: sanitizedRes?.id || null,
          operationName: "chat",
          providerName: "anthropic",
          responseModel: sanitizedRes?.model || sanitizedReq.model || null,
          temperature: sanitizedReq.temperature || null,
          maxTokens: sanitizedReq.max_tokens || null,
          toolDefinitions,
          metadata: enrichedMetadata,
        });

        // Record error event with appropriate error type
        const errorType = isEmptyResponse
          ? "empty_response"
          : stopReason === "stop_sequence"
            ? "content_filtered"
            : "response_truncated";
        const errorMessage = isEmptyResponse
          ? "AI returned empty response"
          : stopReason === "stop_sequence"
            ? "AI response was filtered due to content policy"
            : "AI response was truncated due to token limit";

        opts.observa.trackError({
          errorType: errorType,
          errorMessage: errorMessage,
          stackTrace: null,
          context: {
            request: sanitizedReq,
            response: sanitizedRes,
            model: sanitizedReq.model || sanitizedRes?.model || "unknown",
            input: inputText,
            stop_reason: stopReason,
            provider: "anthropic",
            duration_ms: duration,
          },
          errorCategory:
            stopReason === "stop_sequence"
              ? "validation_error"
              : stopReason === "max_tokens"
                ? "model_error"
                : "unknown_error",
          errorCode: isEmptyResponse ? "empty_response" : stopReason,
        });

        // Don't record as successful trace
        return;
      }

      // Normal successful response - include thinking blocks and tool_use in metadata
      opts.observa.trackLLMCall({
        model: sanitizedReq.model || sanitizedRes?.model || "unknown",
        input: inputText,
        output: outputText,
        inputMessages: normalized.inputMessages,
        outputMessages: normalized.outputMessages,
        inputTokens: sanitizedRes?.usage?.input_tokens || null,
        outputTokens: sanitizedRes?.usage?.output_tokens || null,
        totalTokens:
          (sanitizedRes?.usage?.input_tokens || 0) +
            (sanitizedRes?.usage?.output_tokens || 0) || null,
        latencyMs: duration,
        timeToFirstTokenMs: timeToFirstToken || null,
        streamingDurationMs: streamingDuration || null,
        finishReason: stopReason,
        responseId: sanitizedRes?.id || null,
        operationName: "chat",
        providerName: "anthropic",
        responseModel: sanitizedRes?.model || sanitizedReq.model || null,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.max_tokens || null,
        toolDefinitions,
        metadata: enrichedMetadata,
      });
    }
  } catch (e) {
    // Never crash user's app
    console.error("[Observa] Failed to record trace", e);
  }
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
  preExtractedInputText?: string | null,
  preExtractedInputMessages?: any,
  preExtractedModel?: string,
  preCallTools?: any,
) {
  const duration = Date.now() - start;

  try {
    console.error("[Observa] ⚠️ Error Captured:", error?.message || error);

    // Sanitize request with redact hook
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;

    // CRITICAL: Validate that observa instance is provided
    if (!opts?.observa) {
      console.error(
        "[Observa] ⚠️ CRITICAL: observa instance not provided to observeAnthropic(). " +
          "Error tracking is disabled. Make sure you're using observa.observeAnthropic() " +
          "instead of importing observeAnthropic directly from 'observa-sdk/instrumentation'.",
      );
      return; // Silently fail (don't crash user's app)
    }

    // Use Observa instance if provided
    if (opts.observa) {
      const normalized = buildNormalizedLLMCall({
        request: sanitizedReq,
        provider: "anthropic",
        toolDefsOverride: sanitizedReq?.tools ?? preCallTools,
      });
      const toolDefinitions = normalized.toolDefinitions;
      const otelMetadata = buildOtelMetadata(normalized);
      // Use pre-extracted model if available, otherwise extract from request
      const model = preExtractedModel || sanitizedReq.model || "unknown";

      // Use pre-extracted input text if available (extracted before operation), otherwise extract now
      let inputText: string | null = preExtractedInputText || null;
      let inputMessages: any = preExtractedInputMessages || null;

      if (!inputText) {
        // Fallback: Extract input text from messages
        inputMessages = sanitizedReq.messages || null;
        inputText =
          sanitizedReq.messages
            ?.map((m: any) => {
              if (typeof m.content === "string") return m.content;
              if (Array.isArray(m.content)) {
                return m.content
                  .map((c: any) => c.text || c.type)
                  .filter(Boolean)
                  .join("\n");
              }
              return null;
            })
            .filter(Boolean)
            .join("\n") || null;
      }

      // Extract error information using error utilities
      const extractedError = extractProviderError(error, "anthropic");

      // Create LLM call span with error information so users can see what failed
      // This provides context: model, input, and that it failed
      opts.observa.trackLLMCall({
        model: model,
        input: inputText,
        output: null, // No output on error
        inputMessages: inputMessages,
        outputMessages: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        latencyMs: duration,
        timeToFirstTokenMs: null,
        streamingDurationMs: null,
        finishReason: null,
        responseId: null,
        operationName: "chat",
        providerName: "anthropic",
        responseModel: model,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.max_tokens || null,
        toolDefinitions,
        metadata: otelMetadata,
      });

      // Also create error event with full context and extracted error codes/categories
      opts.observa.trackError({
        errorType: error?.name || extractedError.code || "anthropic_api_error",
        errorMessage: extractedError.message,
        stackTrace: error?.stack || null,
        context: {
          request: sanitizedReq,
          model: model,
          input: inputText,
          provider: "anthropic",
          duration_ms: duration,
          status_code: extractedError.statusCode || null,
        },
        errorCategory: extractedError.category,
        errorCode: extractedError.code,
      });
    }
  } catch (e) {
    // Ignore tracking errors
    console.error("[Observa] Failed to record error", e);
  }
}
