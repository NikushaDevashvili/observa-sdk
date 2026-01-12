/**
 * Context Propagation
 * 
 * Uses AsyncLocalStorage to maintain trace/span context across async operations.
 * This ensures nested spans automatically get the correct parent_span_id.
 * 
 * Edge-compatible: Handles Cloudflare Workers/Vercel Edge where AsyncLocalStorage
 * is not available. Uses waitUntil for edge runtime support.
 */

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

// Safe AsyncLocalStorage wrapper with edge runtime support
let traceContextStorage: any = null;
let edgeContextMap: WeakMap<any, TraceContext> | null = null;

try {
  // Try to use AsyncLocalStorage (Node.js)
  const { AsyncLocalStorage } = require('async_hooks');
  traceContextStorage = new AsyncLocalStorage<TraceContext>();
} catch {
  // Edge runtime - use WeakMap for manual context passing
  edgeContextMap = new WeakMap();
}

/**
 * Get the current trace context (traceId, spanId, parentSpanId)
 */
export function getTraceContext(): TraceContext | undefined {
  try {
    if (traceContextStorage) {
      return traceContextStorage.getStore();
    }
    // Edge runtime - manual context passing required
    // Users must pass context manually or use Vercel waitUntil
    return undefined;
  } catch {
    // Fail gracefully - don't crash
    return undefined;
  }
}

/**
 * For Vercel Edge: use waitUntil to send traces
 * Prevents orphan traces in edge runtime
 */
export function waitUntil(promise: Promise<void>): void {
  try {
    // Vercel Edge: ctx.waitUntil()
    const ctx = (globalThis as any).ctx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(promise);
      return;
    }
    
    // Cloudflare Workers: ctx.waitUntil()
    const cfCtx = (globalThis as any).caches || (globalThis as any).env;
    if (cfCtx && typeof (globalThis as any).EventContext !== 'undefined') {
      // Cloudflare Workers context
      const workerCtx = (globalThis as any).ctx;
      if (workerCtx?.waitUntil) {
        workerCtx.waitUntil(promise);
        return;
      }
    }
  } catch {
    // Ignore errors
  }
  
  // Fallback: execute promise (may not complete in edge)
  promise.catch((err) => {
    console.error('[Observa] waitUntil promise failed:', err);
  });
}

/**
 * Run a function within a trace context
 */
export function runInTraceContext<T>(
  context: TraceContext,
  fn: () => T
): T {
  try {
    if (traceContextStorage) {
      return traceContextStorage.run(context, fn);
    }
    // Edge runtime - execute without context propagation
    // Context must be passed manually
    return fn();
  } catch {
    // Fail gracefully - execute without context
    return fn();
  }
}

/**
 * Run an async function within a trace context
 */
export async function runInTraceContextAsync<T>(
  context: TraceContext,
  fn: () => Promise<T>
): Promise<T> {
  try {
    if (traceContextStorage) {
      return traceContextStorage.run(context, fn);
    }
    // Edge runtime - execute without context propagation
    // Context must be passed manually
    return await fn();
  } catch {
    // Fail gracefully - execute without context
    return await fn();
  }
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

