/**
 * Anthropic SDK Wrapper
 * 
 * Implements observeAnthropic() following same pattern as OpenAI wrapper.
 * Uses Proxy with WeakMap memoization to preserve object identity.
 * Handles streaming with proper teeing (preserves TTFT).
 * Includes PII redaction hooks.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { wrapStream } from './utils';
import { mapAnthropicToOTEL, OTEL_SEMCONV } from './semconv';
import { getTraceContext, waitUntil } from '../context';

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
  options?: ObserveOptions
): Anthropic {
  // Return cached proxy if exists to maintain identity (client === client)
  if (proxyCache.has(client)) {
    return proxyCache.get(client);
  }

  try {
    const wrapped = new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        // Recursive wrapping for nested objects (like client.messages)
        if (typeof value === 'object' && value !== null) {
          // Don't wrap internal prototypes
          if (prop === 'prototype' || prop === 'constructor') {
            return value;
          }

          // Recursive wrap with same options (memoized via proxyCache)
          return observeAnthropic(value as any, options);
        }

        // Intercept the specific function call: messages.create
        if (typeof value === 'function' && prop === 'create') {
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
    console.error('[Observa] Failed to wrap Anthropic client:', error);
    return client; // Return unwrapped client - user code still works
  }
}

/**
 * Trace an Anthropic API call
 */
async function traceAnthropicCall(
  originalFn: Function,
  args: any[],
  options?: ObserveOptions
) {
  const startTime = Date.now();
  const requestParams = args[0] || {};
  const isStreaming = requestParams.stream === true;

  try {
    // 1. Execute Original Call
    const result = await originalFn(...args);

    // 2. Handle Streaming vs Blocking
    if (isStreaming) {
      // Wrap stream to capture data without blocking TTFT
      return wrapStream(
        result,
        (fullResponse) => {
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
        (err) => recordError(requestParams, err, startTime, options),
        'anthropic'
      );
    } else {
      // Standard await -> Send Trace to Observa
      recordTrace(requestParams, result, startTime, options);
      return result;
    }
  } catch (error) {
    recordError(requestParams, error, startTime, options);
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

    // Use Observa instance if provided
    if (opts?.observa) {
      // Extract input text from messages
      const inputText = sanitizedReq.messages
        ?.map((m: any) => {
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .map((c: any) => c.text || c.type)
              .filter(Boolean)
              .join('\n');
          }
          return null;
        })
        .filter(Boolean)
        .join('\n') || null;

      // Extract output text from response
      const outputText = sanitizedRes?.content
        ?.map((c: any) => c.text)
        .filter(Boolean)
        .join('\n') || null;

      // Use existing trackLLMCall method
      opts.observa.trackLLMCall({
        model: sanitizedReq.model || sanitizedRes?.model || 'unknown',
        input: inputText,
        output: outputText,
        inputMessages: sanitizedReq.messages || null,
        outputMessages: sanitizedRes?.content || null,
        inputTokens: sanitizedRes?.usage?.input_tokens || null,
        outputTokens: sanitizedRes?.usage?.output_tokens || null,
        totalTokens:
          (sanitizedRes?.usage?.input_tokens || 0) +
          (sanitizedRes?.usage?.output_tokens || 0) || null,
        latencyMs: duration,
        timeToFirstTokenMs: timeToFirstToken || null,
        streamingDurationMs: streamingDuration || null,
        finishReason: sanitizedRes?.stop_reason || null,
        responseId: sanitizedRes?.id || null,
        operationName: 'chat',
        providerName: 'anthropic',
        responseModel: sanitizedRes?.model || sanitizedReq.model || null,
        temperature: sanitizedReq.temperature || null,
        maxTokens: sanitizedReq.max_tokens || null,
      });
    }
  } catch (e) {
    // Never crash user's app
    console.error('[Observa] Failed to record trace', e);
  }
}

/**
 * Record error to Observa backend
 */
function recordError(req: any, error: any, start: number, opts?: ObserveOptions) {
  try {
    console.error('[Observa] ⚠️ Error Captured:', error?.message || error);
    
    // Sanitize request with redact hook
    const sanitizedReq = opts?.redact ? opts.redact(req) : req;

    // Use Observa instance if provided
    if (opts?.observa) {
      opts.observa.trackError({
        errorType: 'anthropic_api_error',
        errorMessage: error?.message || String(error),
        stackTrace: error?.stack || null,
        context: { request: sanitizedReq },
      });
    }
  } catch (e) {
    // Ignore tracking errors
  }
}
