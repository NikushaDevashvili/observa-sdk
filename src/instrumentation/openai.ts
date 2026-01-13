/**
 * OpenAI SDK Wrapper
 *
 * Implements observeOpenAI() following Langfuse's exact pattern.
 * Uses Proxy with WeakMap memoization to preserve object identity.
 * Handles streaming with proper teeing (preserves TTFT).
 * Includes PII redaction hooks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { wrapStream } from "./utils";
import { mapOpenAIToOTEL, OTEL_SEMCONV } from "./semconv";
import { getTraceContext, waitUntil } from "../context";
import { extractProviderError } from "./error-utils";

// Type for OpenAI client (avoid direct import to handle optional dependency)
type OpenAI = any;

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
 * Observe OpenAI client - wraps client with automatic tracing
 *
 * @param client - OpenAI client instance
 * @param options - Observation options (name, tags, userId, sessionId, redact)
 * @returns Wrapped OpenAI client (same instance reference preserved via WeakMap)
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 * import { observeOpenAI } from 'observa-sdk/instrumentation';
 *
 * const client = new OpenAI({ apiKey: '...' });
 * const wrapped = observeOpenAI(client, {
 *   name: 'my-app',
 *   redact: (data) => ({ ...data, messages: '[REDACTED]' })
 * });
 *
 * // Use wrapped client - automatically tracked!
 * await wrapped.chat.completions.create({ ... });
 * ```
 */
export function observeOpenAI(
  client: OpenAI,
  options?: ObserveOptions
): OpenAI {
  // Return cached proxy if exists to maintain identity (client === client)
  if (proxyCache.has(client)) {
    return proxyCache.get(client);
  }

  // CRITICAL: Warn if observa instance is not provided
  // This is the most common mistake - users importing observeOpenAI directly
  if (!options?.observa) {
    console.error(
      "[Observa] ⚠️ CRITICAL ERROR: observa instance not provided!\n" +
        "\n" +
        "Tracking will NOT work. You must use observa.observeOpenAI() instead.\n" +
        "\n" +
        "❌ WRONG (importing directly):\n" +
        "  import { observeOpenAI } from 'observa-sdk/instrumentation';\n" +
        "  const wrapped = observeOpenAI(openai);\n" +
        "\n" +
        "✅ CORRECT (using instance method):\n" +
        "  import { init } from 'observa-sdk';\n" +
        "  const observa = init({ apiKey: '...' });\n" +
        "  const wrapped = observa.observeOpenAI(openai);\n"
    );
  }

  try {
    const wrapped = new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        // Recursive wrapping for nested objects (like client.chat.completions)
        if (typeof value === "object" && value !== null) {
          // Don't wrap internal prototypes
          if (prop === "prototype" || prop === "constructor") {
            return value;
          }

          // Recursive wrap with same options (memoized via proxyCache)
          return observeOpenAI(value as any, options);
        }

        // Intercept the specific function call: chat.completions.create
        if (typeof value === "function" && prop === "create") {
          // We assume we are at the leaf node (completions.create)
          return async function (...args: any[]) {
            return traceOpenAICall(value.bind(target), args, options);
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
    console.error("[Observa] Failed to wrap OpenAI client:", error);
    return client; // Return unwrapped client - user code still works
  }
}

/**
 * Trace an OpenAI API call
 */
async function traceOpenAICall(
  originalFn: Function,
  args: any[],
  options?: ObserveOptions
) {
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const isStreaming = requestParams.stream === true;

  // Extract input text early (before operation starts) to ensure it's captured even on errors
  const inputText =
    requestParams.messages
      ?.map((m: any) => m.content)
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
            fullResponse.streamingDuration
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
            model
          ),
        "openai"
      );
    } else {
      // Standard await -> Send Trace to Observa
      recordTrace(requestParams, result, startTime, options);
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
      model
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
  streamingDuration?: number | null
) {
  const duration = Date.now() - start;

  // Defensive: Ensure Observa never crashes the app
  try {
    const context = getTraceContext();

    // Sanitize data with redact hook if provided
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;
    const sanitizedRes = opts?.redact ? opts.redact(res) : res;

    // Map to OTEL attributes
    const otelAttributes = mapOpenAIToOTEL(sanitizedReq, sanitizedRes);

    // CRITICAL: Validate that observa instance is provided
    if (!opts?.observa) {
      console.error(
        "[Observa] ⚠️ CRITICAL: observa instance not provided to observeOpenAI(). " +
          "Tracking is disabled. Make sure you're using observa.observeOpenAI() " +
          "instead of importing observeOpenAI directly from 'observa-sdk/instrumentation'."
      );
      return; // Silently fail (don't crash user's app)
    }

    // Use Observa instance if provided
    if (opts.observa) {
      // Extract input text from messages
      const inputText =
        sanitizedReq.messages
          ?.map((m: any) => m.content)
          .filter(Boolean)
          .join("\n") || null;

      // Extract output text from response
      const outputText = sanitizedRes?.choices?.[0]?.message?.content || null;
      
      // Extract finish reason
      const finishReason = sanitizedRes?.choices?.[0]?.finish_reason || null;
      
      // CRITICAL FIX: Detect empty responses
      const isEmptyResponse = !outputText || (typeof outputText === 'string' && outputText.trim().length === 0);
      
      // CRITICAL FIX: Detect failure finish reasons
      const isFailureFinishReason = finishReason === 'content_filter' || finishReason === 'length';
      
      // If response is empty or has failure finish reason, record as error
      if (isEmptyResponse || isFailureFinishReason) {
        // Record LLM call with null output to show the attempt
        opts.observa.trackLLMCall({
          model: sanitizedReq.model || sanitizedRes?.model || "unknown",
          input: inputText,
          output: null, // No output on error
          inputMessages: sanitizedReq.messages || null,
          outputMessages: null,
          inputTokens: sanitizedRes?.usage?.prompt_tokens || null,
          outputTokens: sanitizedRes?.usage?.completion_tokens || null,
          totalTokens: sanitizedRes?.usage?.total_tokens || null,
          latencyMs: duration,
          timeToFirstTokenMs: timeToFirstToken || null,
          streamingDurationMs: streamingDuration || null,
          finishReason: finishReason,
          responseId: sanitizedRes?.id || null,
          operationName: "chat",
          providerName: "openai",
          responseModel: sanitizedRes?.model || sanitizedReq.model || null,
          temperature: sanitizedReq.temperature || null,
          maxTokens: sanitizedReq.max_tokens || null,
        });

        // Record error event with appropriate error type
        const errorType = isEmptyResponse ? "empty_response" : (finishReason === 'content_filter' ? "content_filtered" : "response_truncated");
        const errorMessage = isEmptyResponse 
          ? "AI returned empty response" 
          : (finishReason === 'content_filter' 
            ? "AI response was filtered due to content policy" 
            : "AI response was truncated due to token limit");
        
        opts.observa.trackError({
          errorType: errorType,
          errorMessage: errorMessage,
          stackTrace: null,
          context: {
            request: sanitizedReq,
            response: sanitizedRes,
            model: sanitizedReq.model || sanitizedRes?.model || "unknown",
            input: inputText,
            finish_reason: finishReason,
            provider: "openai",
            duration_ms: duration,
          },
          errorCategory: finishReason === 'content_filter' ? "validation_error" : (finishReason === 'length' ? "model_error" : "unknown_error"),
          errorCode: isEmptyResponse ? "empty_response" : finishReason,
        });
        
        // Don't record as successful trace
        return;
      }

      // Normal successful response - continue with existing logic
      opts.observa.trackLLMCall({
        model: sanitizedReq.model || sanitizedRes?.model || "unknown",
        input: inputText,
        output: outputText,
        inputMessages: sanitizedReq.messages || null,
        outputMessages:
          sanitizedRes?.choices?.map((c: any) => c.message) || null,
        inputTokens: sanitizedRes?.usage?.prompt_tokens || null,
        outputTokens: sanitizedRes?.usage?.completion_tokens || null,
        totalTokens: sanitizedRes?.usage?.total_tokens || null,
        latencyMs: duration,
        timeToFirstTokenMs: timeToFirstToken || null,
        streamingDurationMs: streamingDuration || null,
        finishReason: finishReason,
        responseId: sanitizedRes?.id || null,
        operationName: "chat",
        providerName: "openai",
        responseModel: sanitizedRes?.model || sanitizedReq.model || null,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.max_tokens || null,
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
  preExtractedModel?: string
) {
  const duration = Date.now() - start;

  try {
    console.error("[Observa] ⚠️ Error Captured:", error?.message || error);

    // Sanitize request with redact hook
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;

    // CRITICAL: Validate that observa instance is provided
    if (!opts?.observa) {
      console.error(
        "[Observa] ⚠️ CRITICAL: observa instance not provided to observeOpenAI(). " +
          "Error tracking is disabled. Make sure you're using observa.observeOpenAI() " +
          "instead of importing observeOpenAI directly from 'observa-sdk/instrumentation'."
      );
      return; // Silently fail (don't crash user's app)
    }

    // Use Observa instance if provided
    if (opts.observa) {
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
            ?.map((m: any) => m.content)
            .filter(Boolean)
            .join("\n") || null;
      }

      // Extract error information using error utilities
      const extractedError = extractProviderError(error, "openai");

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
        providerName: "openai",
        responseModel: model,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.max_tokens || null,
      });

      // Also create error event with full context and extracted error codes/categories
      opts.observa.trackError({
        errorType: error?.name || extractedError.code || "openai_api_error",
        errorMessage: extractedError.message,
        stackTrace: error?.stack || null,
        context: {
          request: sanitizedReq,
          model: model,
          input: inputText,
          provider: "openai",
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
