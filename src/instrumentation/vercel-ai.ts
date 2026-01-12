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

// Type for Vercel AI SDK functions (avoid direct import to handle optional dependency)
type GenerateTextFn = any;
type StreamTextFn = any;

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
    if (parts.length > 1) {
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

/**
 * Trace a generateText call
 */
async function traceGenerateText(
  originalFn: GenerateTextFn,
  args: any[],
  options?: ObserveOptions
) {
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const model = requestParams.model || "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);

  try {
    const result = await originalFn(...args);

    // Extract response data
    const responseText = result.text || "";
    const usage = result.usage || {};
    const finishReason = result.finishReason || null;
    const responseId = result.response?.id || null;

    // Extract model from response if available, otherwise use identifier
    const responseModel = result.model
      ? extractModelIdentifier(result.model)
      : modelIdentifier;

    // Record trace
    recordTrace(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt || requestParams.messages || null,
        messages: requestParams.messages || null,
      },
      {
        text: responseText,
        usage,
        finishReason,
        responseId,
        model: responseModel,
      },
      startTime,
      options,
      null, // No streaming for generateText
      null,
      provider
    );

    return result;
  } catch (error) {
    recordError(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt || requestParams.messages || null,
      },
      error,
      startTime,
      options
    );
    throw error;
  }
}

/**
 * Trace a streamText call
 */
async function traceStreamText(
  originalFn: StreamTextFn,
  args: any[],
  options?: ObserveOptions
) {
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const model = requestParams.model || "unknown";
  const provider = extractProviderFromModel(model);
  const modelIdentifier = extractModelIdentifier(model);

  try {
    const result = await originalFn(...args);

    // Vercel AI SDK streamText returns an object with .textStream and other properties
    // We need to wrap the textStream async iterator
    if (result.textStream) {
      const wrappedStream = wrapStream(
        result.textStream,
        (fullResponse) => {
          recordTrace(
            {
              model: modelIdentifier,
              prompt: requestParams.prompt || requestParams.messages || null,
              messages: requestParams.messages || null,
            },
            fullResponse,
            startTime,
            options,
            fullResponse.timeToFirstToken,
            fullResponse.streamingDuration,
            provider
          );
        },
        (err) =>
          recordError(
            {
              model: modelIdentifier,
              prompt: requestParams.prompt || requestParams.messages || null,
            },
            err,
            startTime,
            options
          ),
        "vercel-ai"
      );

      // Return result with wrapped stream - preserve all original properties and methods
      // Use Object.create to preserve prototype chain (for methods like toTextStreamResponse)
      // Then copy all properties with Object.assign
      const wrappedResult = Object.create(Object.getPrototypeOf(result));
      Object.assign(wrappedResult, result);
      
      // textStream is a getter-only property, so we need to use Object.defineProperty to override it
      Object.defineProperty(wrappedResult, 'textStream', {
        value: wrappedStream,
        writable: true,
        enumerable: true,
        configurable: true
      });

      // If toTextStreamResponse exists, we need to bind it properly
      // But since we're replacing textStream, we might need to recreate the method
      // However, Vercel AI SDK's toTextStreamResponse might use the original textStream
      // So we preserve the original method - it should work with our wrapped stream

      return wrappedResult;
    }

    // If no textStream, just record the result
    recordTrace(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt || requestParams.messages || null,
        messages: requestParams.messages || null,
      },
      result,
      startTime,
      options,
      null,
      null,
      provider
    );

    return result;
  } catch (error) {
    recordError(
      {
        model: modelIdentifier,
        prompt: requestParams.prompt || requestParams.messages || null,
      },
      error,
      startTime,
      options
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
  provider?: string
) {
  const duration = Date.now() - start;

  try {
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;
    const sanitizedRes = opts?.redact ? opts.redact(res) : req;

    if (opts?.observa) {
      // Extract input text from prompt or messages
      let inputText: string | null = null;
      if (sanitizedReq.prompt) {
        inputText =
          typeof sanitizedReq.prompt === "string"
            ? sanitizedReq.prompt
            : JSON.stringify(sanitizedReq.prompt);
      } else if (sanitizedReq.messages) {
        inputText = sanitizedReq.messages
          .map((m: any) => m.content || m.text || "")
          .filter(Boolean)
          .join("\n");
      }

      // Extract output text
      const outputText = sanitizedRes.text || sanitizedRes.content || null;

      // Extract usage
      const usage = sanitizedRes.usage || {};
      const inputTokens = usage.promptTokens || usage.inputTokens || null;
      const outputTokens = usage.completionTokens || usage.outputTokens || null;
      const totalTokens = usage.totalTokens || null;

      opts.observa.trackLLMCall({
        model: sanitizedReq.model || sanitizedRes.model || "unknown",
        input: inputText,
        output: outputText,
        inputMessages: sanitizedReq.messages || null,
        outputMessages: sanitizedRes.messages || null,
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs: duration,
        timeToFirstTokenMs: timeToFirstToken || null,
        streamingDurationMs: streamingDuration || null,
        finishReason: sanitizedRes.finishReason || null,
        responseId: sanitizedRes.responseId || sanitizedRes.id || null,
        operationName: "generate_text",
        providerName: provider || "vercel-ai",
        responseModel: sanitizedRes.model || sanitizedReq.model || null,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.maxTokens || sanitizedReq.max_tokens || null,
      });
    }
  } catch (e) {
    console.error("[Observa] Failed to record trace", e);
  }
}

/**
 * Record error to Observa backend
 */
function recordError(
  req: any,
  error: any,
  start: number,
  opts?: ObserveOptions
) {
  try {
    console.error("[Observa] ⚠️ Error Captured:", error.message);
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;
    if (opts?.observa) {
      opts.observa.trackError({
        errorType: error.name || "UnknownError",
        errorMessage: error.message || "An unknown error occurred",
        stackTrace: error.stack,
        context: { request: sanitizedReq },
        errorCategory: "llm_error",
      });
    }
  } catch (e) {
    // Ignore errors in error handling
  }
}

/**
 * Observe Vercel AI SDK - wraps generateText and streamText functions
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
  options?: ObserveOptions
): {
  generateText?: GenerateTextFn;
  streamText?: StreamTextFn;
  [key: string]: any;
} {
  try {
    const wrapped: any = { ...aiSdk };

    // Wrap generateText if available
    if (aiSdk.generateText && typeof aiSdk.generateText === "function") {
      wrapped.generateText = async function (...args: any[]) {
        return traceGenerateText(aiSdk.generateText.bind(aiSdk), args, options);
      };
    }

    // Wrap streamText if available
    if (aiSdk.streamText && typeof aiSdk.streamText === "function") {
      wrapped.streamText = async function (...args: any[]) {
        return traceStreamText(aiSdk.streamText.bind(aiSdk), args, options);
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
