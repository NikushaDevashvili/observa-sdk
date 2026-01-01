/**
 * Context Propagation
 * 
 * Uses AsyncLocalStorage to maintain trace/span context across async operations.
 * This ensures nested spans automatically get the correct parent_span_id.
 */

import { AsyncLocalStorage } from "async_hooks";

interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

// Global async context storage
const traceContextStorage = new AsyncLocalStorage<TraceContext>();

/**
 * Get the current trace context (traceId, spanId, parentSpanId)
 */
export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

/**
 * Run a function within a trace context
 */
export function runInTraceContext<T>(
  context: TraceContext,
  fn: () => T
): T {
  return traceContextStorage.run(context, fn);
}

/**
 * Run an async function within a trace context
 */
export async function runInTraceContextAsync<T>(
  context: TraceContext,
  fn: () => Promise<T>
): Promise<T> {
  return traceContextStorage.run(context, fn);
}

/**
 * Create a new span context (child of current context if available)
 */
export function createSpanContext(
  traceId: string,
  spanId: string,
  parentSpanId?: string | null
): TraceContext {
  // If we're already in a trace context, use its traceId and make it the parent
  const currentContext = getTraceContext();
  
  if (currentContext) {
    return {
      traceId: currentContext.traceId,
      spanId,
      parentSpanId: currentContext.spanId, // Current span becomes parent
    };
  }

  // No current context, create new trace
  return {
    traceId,
    spanId,
    parentSpanId: parentSpanId ?? null,
  };
}

