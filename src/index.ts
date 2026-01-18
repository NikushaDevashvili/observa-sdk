/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------
// Observa SDK (Speed MVP)
// - Captures streaming AI responses (ReadableStream.tee)
// - Logs beautifully in dev mode
// - Sends events to Tinybird Events API in NDJSON
// ------------------------------------------------------------

// Import instrumentation wrappers (tsup bundles everything together)
import { observeOpenAI as observeOpenAIFn } from "./instrumentation/openai.js";
import { observeAnthropic as observeAnthropicFn } from "./instrumentation/anthropic.js";
import { observeVercelAI as observeVercelAIFn } from "./instrumentation/vercel-ai.js";

// Helper: safely access NODE_ENV without type issues
function getNodeEnv(): string | undefined {
  try {
    const proc = (globalThis as any).process;
    return proc?.env?.NODE_ENV;
  } catch {
    return undefined;
  }
}

// ---------- JWT Decoding (for tenant context extraction) ----------
interface JWTPayload {
  tenantId?: string;
  projectId?: string;
  environment?: "dev" | "prod";
  iat?: number;
  exp?: number;
  [key: string]: any;
}

/**
 * Decodes a JWT token and extracts the payload
 * JWT format: header.payload.signature (we only need the payload)
 * Returns null if the token is not a valid JWT format
 */
function decodeJWT(token: string): JWTPayload | null {
  try {
    // JWT format: header.payload.signature
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null; // Not a JWT
    }

    // Decode the payload (second part)
    const payload = parts[1];
    if (!payload) {
      return null;
    }

    // Base64URL decode (replace URL-safe chars and add padding if needed)
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

    // Decode base64 (works in both browser and Node.js)
    let decoded: string;
    try {
      if (typeof atob !== "undefined") {
        // Browser environment
        decoded = atob(padded);
      } else {
        // Node.js environment - use Buffer if available
        const BufferClass = (globalThis as any).Buffer;
        if (BufferClass) {
          decoded = BufferClass.from(padded, "base64").toString("utf-8");
        } else {
          // No base64 decoder available - this shouldn't happen in normal environments
          return null;
        }
      }
    } catch {
      return null; // Base64 decoding failed
    }

    // Parse JSON payload
    return JSON.parse(decoded) as JWTPayload;
  } catch {
    return null; // Invalid JWT format
  }
}

/**
 * Extracts tenant context from API key (JWT) or returns null
 * Supports both JWT format (new) and legacy format (returns null)
 */
function extractTenantContextFromAPIKey(apiKey: string): {
  tenantId: string;
  projectId: string;
  environment?: "dev" | "prod";
} | null {
  const payload = decodeJWT(apiKey);
  if (!payload) {
    return null; // Not a JWT, treat as legacy format
  }

  // Extract tenant context from JWT payload
  const tenantId = payload.tenantId;
  const projectId = payload.projectId;

  if (!tenantId || !projectId) {
    return null; // JWT missing required fields
  }

  const result: {
    tenantId: string;
    projectId: string;
    environment?: "dev" | "prod";
  } = {
    tenantId,
    projectId,
  };
  if (payload.environment !== undefined) {
    result.environment = payload.environment;
  }
  return result;
}

// ---------- Types ----------
export interface ObservaInitConfig {
  // Observa API key (JWT that encodes tenant/project context, or legacy token)
  // If JWT: tenantId/projectId are extracted automatically
  // If legacy: tenantId/projectId must be provided explicitly
  apiKey: string;

  // Multi-tenant stamps (optional if API key is a JWT)
  // Required if using legacy API key format
  tenantId?: string;
  projectId?: string;
  environment?: "dev" | "prod";

  // Observa backend URL (default: https://api.observa.ai)
  // For development, can be set to http://localhost:3000
  apiUrl?: string;

  // SDK behavior
  mode?: "development" | "production";
  sampleRate?: number; // 0..1
  maxResponseChars?: number; // prevent giant payloads (default 50k)
}

interface TraceData {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;

  timestamp: string;

  tenantId: string;
  projectId: string;
  environment: "dev" | "prod";

  query: string;
  context?: string;
  model?: string;
  metadata?: Record<string, any>;

  response: string;
  responseLength: number;

  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;

  latencyMs: number;
  timeToFirstTokenMs?: number | null;
  streamingDurationMs?: number | null;

  status?: number | null;
  statusText?: string | null;

  finishReason?: string | null;
  responseId?: string | null;
  systemFingerprint?: string | null;

  headers?: Record<string, string>;

  // Conversation tracking fields
  conversationId?: string;
  sessionId?: string;
  userId?: string;
  messageIndex?: number;
  parentMessageId?: string;
}

/**
 * Canonical event format for Observa API
 */
type EventType =
  | "llm_call"
  | "tool_call"
  | "retrieval"
  | "error"
  | "feedback"
  | "output"
  | "trace_start"
  | "trace_end"
  | "embedding"
  | "vector_db_operation"
  | "cache_operation"
  | "agent_create";

interface CanonicalEvent {
  tenant_id: string;
  project_id: string;
  environment: "dev" | "prod";
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  timestamp: string;
  event_type: EventType;
  conversation_id?: string | null;
  session_id?: string | null;
  user_id?: string | null;
  agent_name?: string | null;
  version?: string | null;
  route?: string | null;
  attributes: {
    llm_call?: {
      model: string;
      input?: string | null;
      output?: string | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
      total_tokens?: number | null;
      latency_ms: number;
      time_to_first_token_ms?: number | null;
      streaming_duration_ms?: number | null;
      finish_reason?: string | null;
      response_id?: string | null;
      system_fingerprint?: string | null;
      cost?: number | null;
      // TIER 1: OTEL Semantic Conventions
      operation_name?:
        | "chat"
        | "text_completion"
        | "generate_content"
        | string
        | null;
      provider_name?: string | null;
      response_model?: string | null;
      // TIER 2: Sampling parameters
      top_k?: number | null;
      top_p?: number | null;
      frequency_penalty?: number | null;
      presence_penalty?: number | null;
      stop_sequences?: string[] | null;
      seed?: number | null;
      temperature?: number | null;
      max_tokens?: number | null;
      // TIER 2: Structured cost tracking
      input_cost?: number | null;
      output_cost?: number | null;
      // TIER 1: Structured message objects
      input_messages?: Array<{
        role: string;
        content?: string | any;
        parts?: Array<{ type: string; content: any }>;
      }> | null;
      output_messages?: Array<{
        role: string;
        content?: string | any;
        parts?: Array<{ type: string; content: any }>;
        finish_reason?: string;
      }> | null;
      system_instructions?: Array<{
        type: string;
        content: string | any;
      }> | null;
      // TIER 2: Server metadata
      server_address?: string | null;
      server_port?: number | null;
      // TIER 2: Conversation grouping
      conversation_id_otel?: string | null;
      choice_count?: number | null;
      // CRITICAL: Status field to mark errors (backend will use this to set span status)
      status?: "success" | "error" | null;
    };
    tool_call?: {
      tool_name: string;
      args?: Record<string, any> | null;
      result?: any | null;
      result_status: "success" | "error" | "timeout";
      latency_ms: number;
      error_message?: string | null;
      // TIER 2: OTEL Tool Standardization
      operation_name?: "execute_tool" | string | null;
      tool_type?: "function" | "extension" | "datastore" | string | null;
      tool_description?: string | null;
      tool_call_id?: string | null;
      error_type?: string | null;
      error_category?: string | null;
    };
    retrieval?: {
      retrieval_context_ids?: string[] | null;
      retrieval_context_hashes?: string[] | null;
      k?: number | null;
      latency_ms: number;
      top_k?: number | null;
      similarity_scores?: number[] | null;
      // TIER 2: Retrieval enrichment
      retrieval_context?: string | null;
      embedding_model?: string | null;
      embedding_dimensions?: number | null;
      vector_metric?: "cosine" | "euclidean" | "dot_product" | string | null;
      rerank_score?: number | null;
      fusion_method?: string | null;
      deduplication_removed_count?: number | null;
      quality_score?: number | null;
    };
    error?: {
      error_type: string;
      error_message: string;
      stack_trace?: string | null;
      context?: Record<string, any> | null;
      // TIER 2: Structured error classification
      error_category?: string | null;
      error_code?: string | null;
    };
    embedding?: {
      model: string;
      dimension_count?: number | null;
      encoding_formats?: string[] | null;
      input_tokens?: number | null;
      output_tokens?: number | null;
      latency_ms: number;
      cost?: number | null;
      input_text?: string | null;
      input_hash?: string | null;
      embeddings?: number[][] | null;
      embeddings_hash?: string | null;
      operation_name?: "embeddings" | string | null;
      provider_name?: string | null;
    };
    vector_db_operation?: {
      operation_type: "vector_search" | "index_upsert" | "delete" | string;
      index_name?: string | null;
      index_version?: string | null;
      vector_dimensions?: number | null;
      vector_metric?: "cosine" | "euclidean" | "dot_product" | string | null;
      results_count?: number | null;
      scores?: number[] | null;
      latency_ms: number;
      cost?: number | null;
      api_version?: string | null;
      provider_name?: string | null;
    };
    cache_operation?: {
      cache_backend?: "redis" | "in_memory" | "memcached" | string | null;
      cache_key?: string | null;
      cache_namespace?: string | null;
      hit_status: "hit" | "miss";
      latency_ms: number;
      saved_cost?: number | null;
      ttl?: number | null;
      eviction_info?: Record<string, any> | null;
    };
    agent_create?: {
      agent_name: string;
      agent_config?: Record<string, any> | null;
      tools_bound?: string[] | null;
      model_config?: Record<string, any> | null;
      operation_name?: "create_agent" | string | null;
    };
    output?: {
      final_output?: string | null;
      output_length?: number | null;
    };
    feedback?: {
      type: "like" | "dislike" | "rating" | "correction";
      rating?: number | null;
      comment?: string | null;
      outcome?: "success" | "failure" | "partial" | null;
    };
    trace_start?: {
      name?: string | null;
      metadata?: Record<string, any> | null;
    };
    trace_end?: {
      total_latency_ms?: number | null;
      total_tokens?: number | null;
      total_cost?: number | null;
      outcome?: "success" | "error" | "timeout" | null;
    };
    [key: string]: any;
  };
}

// ---------- Pretty logging ----------
function formatBeautifulLog(trace: TraceData) {
  const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    gray: "\x1b[90m",
  };

  const formatValue = (
    label: string,
    value: any,
    color: string = colors.cyan
  ) => `${colors.dim}${label}:${colors.reset} ${color}${value}${colors.reset}`;

  console.log("\n" + "═".repeat(90));
  console.log(
    `${colors.bright}${colors.blue}🔍 OBSERVA TRACE${colors.reset} ${colors.gray}${trace.traceId}${colors.reset}`
  );
  console.log("─".repeat(90));

  console.log(`${colors.bright}🏷 Tenant${colors.reset}`);
  console.log(`  ${formatValue("tenantId", trace.tenantId, colors.gray)}`);
  console.log(`  ${formatValue("projectId", trace.projectId, colors.gray)}`);
  console.log(`  ${formatValue("env", trace.environment, colors.gray)}`);

  console.log(`\n${colors.bright}📋 Request${colors.reset}`);
  console.log(
    `  ${formatValue(
      "Timestamp",
      new Date(trace.timestamp).toLocaleString(),
      colors.gray
    )}`
  );
  if (trace.model)
    console.log(`  ${formatValue("Model", trace.model, colors.yellow)}`);

  const queryPreview =
    trace.query.length > 80 ? trace.query.slice(0, 80) + "..." : trace.query;
  console.log(`  ${formatValue("Query", queryPreview, colors.green)}`);

  if (trace.context) {
    const ctxPreview =
      trace.context.length > 120
        ? trace.context.slice(0, 120) + "..."
        : trace.context;
    console.log(`  ${formatValue("Context", ctxPreview, colors.cyan)}`);
  }

  console.log(`\n${colors.bright}⚡ Performance${colors.reset}`);
  console.log(
    `  ${formatValue("Latency", `${trace.latencyMs}ms`, colors.green)}`
  );
  if (trace.timeToFirstTokenMs != null) {
    console.log(
      `  ${formatValue("TTFB", `${trace.timeToFirstTokenMs}ms`, colors.cyan)}`
    );
  }
  if (trace.streamingDurationMs != null) {
    console.log(
      `  ${formatValue(
        "Streaming",
        `${trace.streamingDurationMs}ms`,
        colors.cyan
      )}`
    );
  }

  console.log(`\n${colors.bright}🪙 Tokens${colors.reset}`);
  if (trace.tokensPrompt != null)
    console.log(`  ${formatValue("Prompt", trace.tokensPrompt)}`);
  if (trace.tokensCompletion != null)
    console.log(`  ${formatValue("Completion", trace.tokensCompletion)}`);
  if (trace.tokensTotal != null)
    console.log(
      `  ${formatValue(
        "Total",
        trace.tokensTotal,
        colors.bright + colors.yellow
      )}`
    );

  console.log(`\n${colors.bright}📤 Response${colors.reset}`);
  console.log(
    `  ${formatValue(
      "Length",
      `${trace.responseLength.toLocaleString()} chars`,
      colors.cyan
    )}`
  );
  if (trace.status != null) {
    const statusColor =
      trace.status >= 200 && trace.status < 300 ? colors.green : colors.yellow;
    console.log(
      `  ${formatValue(
        "Status",
        `${trace.status} ${trace.statusText ?? ""}`,
        statusColor
      )}`
    );
  }
  if (trace.finishReason)
    console.log(
      `  ${formatValue("Finish", trace.finishReason, colors.magenta)}`
    );

  const respPreview =
    trace.response.length > 300
      ? trace.response.slice(0, 300) + "..."
      : trace.response;
  console.log(`\n${colors.bright}💬 Response Preview${colors.reset}`);
  console.log(`${colors.dim}${respPreview}${colors.reset}`);

  if (trace.metadata && Object.keys(trace.metadata).length) {
    console.log(`\n${colors.bright}📎 Metadata${colors.reset}`);
    for (const [k, v] of Object.entries(trace.metadata)) {
      const valueStr = typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`  ${formatValue(k, valueStr, colors.gray)}`);
    }
  }

  console.log("═".repeat(90) + "\n");
}

// ------------------------------------------------------------
// SDK
// ------------------------------------------------------------
export class Observa {
  private apiKey: string;
  private instanceId: string;

  private tenantId: string;
  private projectId: string;
  private environment: "dev" | "prod";

  private apiUrl: string;

  private isProduction: boolean;
  private sampleRate: number;
  private maxResponseChars: number;

  // Buffering and retry (now stores canonical events)
  private eventBuffer: CanonicalEvent[] = [];
  private flushPromise: Promise<void> | null = null;
  private flushInProgress = false;
  private maxBufferSize = 100;
  private flushIntervalMs = 5000; // Flush every 5 seconds
  private flushIntervalId: ReturnType<typeof setInterval> | null = null;

  // Span hierarchy tracking (for manual trace management)
  private currentTraceId: string | null = null;
  private rootSpanId: string | null = null;
  private spanStack: string[] = []; // Stack for tracking parent-child relationships
  private traceStartTime: number | null = null;

  // Track traces with errors (for automatic trace_end generation when using instrumentation)
  private tracesWithErrors: Set<string> = new Set();
  // Track root span IDs for traces (for automatic trace_end generation)
  private traceRootSpanIds: Map<string, string> = new Map();
  // Track known span IDs per trace to validate feedback parentSpanId
  private traceSpanIds: Map<string, Set<string>> = new Map();

  private registerSpanForTrace(traceId: string | null | undefined, spanId: string): void {
    if (!traceId) return;
    const existing = this.traceSpanIds.get(traceId);
    if (existing) {
      existing.add(spanId);
      return;
    }
    this.traceSpanIds.set(traceId, new Set([spanId]));
  }

  constructor(config: ObservaInitConfig) {
    this.apiKey = config.apiKey;
    this.instanceId = crypto.randomUUID();

    // Observa backend URL (defaults to production, can override for dev)
    let apiUrlEnv: string | undefined;
    try {
      const proc = (globalThis as any).process;
      apiUrlEnv = proc?.env?.OBSERVA_API_URL;
    } catch {
      // Ignore
    }
    this.apiUrl = config.apiUrl || apiUrlEnv || "https://api.observa.ai";

    // Extract tenant context from JWT or use config (backward compatible)
    const jwtContext = extractTenantContextFromAPIKey(config.apiKey);

    if (jwtContext) {
      // JWT format: extract tenant context from API key
      this.tenantId = jwtContext.tenantId;
      this.projectId = jwtContext.projectId;
      this.environment = jwtContext.environment ?? config.environment ?? "dev";
    } else {
      // Legacy format: require tenantId/projectId in config
      if (!config.tenantId || !config.projectId) {
        throw new Error(
          "Observa SDK: tenantId and projectId are required when using legacy API key format. " +
            "Either provide a JWT-formatted API key (which encodes tenant/project context) " +
            "or explicitly provide tenantId and projectId in the config."
        );
      }
      this.tenantId = config.tenantId;
      this.projectId = config.projectId;
      this.environment = config.environment ?? "dev";
    }

    // Validate tenant context is set
    if (!this.tenantId || !this.projectId) {
      throw new Error(
        "Observa SDK: tenantId and projectId must be set. " +
          "This should never happen - please report this error."
      );
    }

    const nodeEnv = getNodeEnv();
    this.isProduction =
      config.mode === "production" || nodeEnv === "production";

    this.sampleRate =
      typeof config.sampleRate === "number" ? config.sampleRate : 1.0;
    this.maxResponseChars = config.maxResponseChars ?? 50_000;

    console.log(
      `💧 Observa SDK Initialized (${
        this.isProduction ? "production" : "development"
      })`
    );

    // Debug logging
    if (!this.isProduction) {
      console.log(`🔗 [Observa] API URL: ${this.apiUrl}`);
      console.log(`🔗 [Observa] Tenant: ${this.tenantId}`);
      console.log(`🔗 [Observa] Project: ${this.projectId}`);
      console.log(
        `🔗 [Observa] Auth: ${
          jwtContext ? "JWT (auto-extracted)" : "Legacy (config)"
        }`
      );
    }

    // Start periodic flush (in Node.js environment)
    try {
      if (typeof setInterval !== "undefined") {
        this.flushIntervalId = setInterval(() => {
          this.flush().catch((err) => {
            console.error("[Observa] Periodic flush failed:", err);
          });
        }, this.flushIntervalMs);
      }
    } catch {
      // Not available in browser/edge runtime
    }
  }

  /**
   * Flush buffered events to the API
   * Returns a promise that resolves when all events are sent
   */
  async flush(): Promise<void> {
    if (this.flushInProgress || this.eventBuffer.length === 0) {
      return this.flushPromise || Promise.resolve();
    }

    this.flushInProgress = true;
    this.flushPromise = this._doFlush();

    try {
      await this.flushPromise;
    } finally {
      this.flushInProgress = false;
      this.flushPromise = null;
    }
  }

  /**
   * Helper: Create base event properties
   */
  private createBaseEventProperties(): {
    tenant_id: string;
    project_id: string;
    environment: "dev" | "prod";
    trace_id: string;
  } {
    const traceId = this.currentTraceId || crypto.randomUUID();
    return {
      tenant_id: this.tenantId,
      project_id: this.projectId,
      environment: this.environment,
      trace_id: traceId,
    };
  }

  /**
   * Helper: Add event to buffer with proper span hierarchy
   */
  private addEvent(
    eventData: Partial<CanonicalEvent> & {
      event_type: EventType;
      attributes: any;
    }
  ): void {
    const baseProps = this.createBaseEventProperties();
    const parentSpanId =
      this.spanStack.length > 0
        ? this.spanStack[this.spanStack.length - 1]
        : null;

    const spanId = eventData.span_id || crypto.randomUUID();

    // Track root span IDs for traces (for automatic trace_end generation)
    // When using instrumentation without startTrace, the first event's span becomes the root
    if (
      !this.currentTraceId &&
      !this.traceRootSpanIds.has(baseProps.trace_id)
    ) {
      this.traceRootSpanIds.set(baseProps.trace_id, spanId);
    }

    const event: CanonicalEvent = {
      ...baseProps,
      trace_id: (eventData as any).trace_id ?? baseProps.trace_id,
      span_id: spanId,
      parent_span_id:
        (eventData.parent_span_id !== undefined
          ? eventData.parent_span_id
          : parentSpanId) ?? null,
      timestamp: eventData.timestamp || new Date().toISOString(),
      event_type: eventData.event_type,
      conversation_id: eventData.conversation_id ?? null,
      session_id: eventData.session_id ?? null,
      user_id: eventData.user_id ?? null,
      agent_name: eventData.agent_name ?? null,
      version: eventData.version ?? null,
      route: eventData.route ?? null,
      attributes: eventData.attributes,
    };

    if (event.event_type === "llm_call") {
      const llmAttrs: any = (event as any)?.attributes?.llm_call || {};
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "index.ts:addEvent",
            message: "llm_call event buffered",
            data: {
              model: llmAttrs.model || null,
              provider: llmAttrs.provider_name || null,
              inputLength:
                typeof llmAttrs.input === "string" ? llmAttrs.input.length : 0,
              outputLength:
                typeof llmAttrs.output === "string"
                  ? llmAttrs.output.length
                  : 0,
              status: llmAttrs.status || null,
              traceId: event.trace_id,
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "E",
          }),
        }
      ).catch(() => {});
      // #endregion
    }

    this.eventBuffer.push(event);

    // Auto-flush if buffer is full
    if (this.eventBuffer.length >= this.maxBufferSize) {
      this.flush().catch((err) => {
        console.error("[Observa] Auto-flush failed:", err);
      });
    }
  }

  /**
   * Start a new trace (manual trace management)
   */
  startTrace(
    options: {
      name?: string;
      metadata?: Record<string, any>;
      conversationId?: string;
      sessionId?: string;
      userId?: string;
    } = {}
  ): string {
    // End previous trace if active
    if (this.currentTraceId) {
      console.warn("[Observa] Ending previous trace before starting new one");
      this.endTrace().catch(console.error);
    }

    this.currentTraceId = crypto.randomUUID();
    this.rootSpanId = crypto.randomUUID();
    this.spanStack = [this.rootSpanId];
    this.traceStartTime = Date.now();
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:startTrace",
        message: "startTrace called",
        data: {
          instanceId: this.instanceId,
          currentTraceId: this.currentTraceId,
          rootSpanId: this.rootSpanId,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "J",
      }),
    }).catch(() => {});
    // #endregion

    this.addEvent({
      event_type: "trace_start",
      span_id: this.rootSpanId,
      parent_span_id: null,
      conversation_id: options.conversationId || null,
      session_id: options.sessionId || null,
      user_id: options.userId || null,
      attributes: {
        trace_start: {
          name: options.name || null,
          metadata: options.metadata || null,
        },
      },
    });

    return this.currentTraceId;
  }

  /**
   * Check if a trace is currently active
   */
  hasActiveTrace(): boolean {
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:hasActiveTrace",
        message: "hasActiveTrace called",
        data: {
          instanceId: this.instanceId,
          currentTraceId: this.currentTraceId,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "J",
      }),
    }).catch(() => {});
    // #endregion
    return !!this.currentTraceId;
  }

  /**
   * Debug helper: expose current trace id
   */
  getCurrentTraceId(): string | null {
    return this.currentTraceId;
  }

  /**
   * Track an LLM call with full OTEL support
   * CRITICAL: This is the primary method for tracking LLM calls with all SOTA parameters
   */
  trackLLMCall(options: {
    model: string;
    input?: string | null;
    output?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    latencyMs: number;
    timeToFirstTokenMs?: number | null;
    streamingDurationMs?: number | null;
    finishReason?: string | null;
    responseId?: string | null;
    systemFingerprint?: string | null;
    cost?: number | null;
    temperature?: number | null;
    maxTokens?: number | null;
    // TIER 1: OTEL Semantic Conventions
    operationName?:
      | "chat"
      | "text_completion"
      | "generate_content"
      | string
      | null;
    providerName?: string | null; // e.g., "openai", "anthropic", "gcp.vertex_ai"
    responseModel?: string | null; // Actual model used vs requested
    // TIER 2: Sampling parameters
    topK?: number | null;
    topP?: number | null;
    frequencyPenalty?: number | null;
    presencePenalty?: number | null;
    stopSequences?: string[] | null;
    seed?: number | null;
    // TIER 2: Structured cost tracking
    inputCost?: number | null;
    outputCost?: number | null;
    // TIER 1: Structured message objects
    inputMessages?: Array<{
      role: string;
      content?: string | any;
      parts?: Array<{ type: string; content: any }>;
    }> | null;
    outputMessages?: Array<{
      role: string;
      content?: string | any;
      parts?: Array<{ type: string; content: any }>;
      finish_reason?: string;
    }> | null;
    systemInstructions?: Array<{
      type: string;
      content: string | any;
    }> | null;
    // TIER 2: Server metadata
    serverAddress?: string | null;
    serverPort?: number | null;
    // TIER 2: Conversation grouping
    conversationIdOtel?: string | null;
    choiceCount?: number | null;
    // Optional linkage
    traceId?: string | null;
    // Additional metadata (tools, toolChoice, settings, etc.)
    metadata?: Record<string, any> | null;
  }): string {
    const spanId = crypto.randomUUID();
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:trackLLMCall",
        message: "trackLLMCall inputs",
        data: {
          model: options.model,
          providerName: options.providerName ?? null,
          hasOutput:
            typeof options.output === "string"
              ? options.output.length > 0
              : options.output !== null,
          inputLength:
            typeof options.input === "string" ? options.input.length : 0,
          currentTraceId: this.currentTraceId,
          spanStackDepth: this.spanStack.length,
          traceId: options.traceId ?? null,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "D",
      }),
    }).catch(() => {});
    // #endregion

    // Auto-infer provider from model if not provided
    let providerName = options.providerName;
    if (!providerName && options.model) {
      const modelLower = options.model.toLowerCase();
      if (modelLower.includes("gpt") || modelLower.includes("openai")) {
        providerName = "openai";
      } else if (
        modelLower.includes("claude") ||
        modelLower.includes("anthropic")
      ) {
        providerName = "anthropic";
      } else if (
        modelLower.includes("gemini") ||
        modelLower.includes("google")
      ) {
        providerName = "google";
      } else if (modelLower.includes("vertex")) {
        providerName = "gcp.vertex_ai";
      } else if (modelLower.includes("bedrock") || modelLower.includes("aws")) {
        providerName = "aws.bedrock";
      }
    }

    // Auto-infer operation name if not provided
    const operationName = options.operationName || "chat";

    // CRITICAL FIX: Mark span as error if output is null (empty response)
    const isError =
      options.output === null ||
      (typeof options.output === "string" &&
        options.output.trim().length === 0) ||
      options.finishReason === "content_filter" ||
      options.finishReason === "length" ||
      options.finishReason === "max_tokens";

    // CRITICAL FIX: Ensure input is always a string or null, never an object
    // This prevents "[object Object]" from appearing in the data
    let normalizedInput: string | null = null;
    if (options.input !== null && options.input !== undefined) {
      if (typeof options.input === "string") {
        normalizedInput = options.input;
      } else {
        // If input is an object, stringify it
        try {
          normalizedInput = JSON.stringify(options.input);
        } catch {
          normalizedInput = String(options.input);
        }
      }
    } else if (options.inputMessages && options.inputMessages.length > 0) {
      // Fallback: if input is null but we have messages, stringify them
      try {
        normalizedInput = JSON.stringify(options.inputMessages);
      } catch {
        normalizedInput = null;
      }
    }

    this.addEvent({
      ...(options.traceId ? { trace_id: options.traceId } : {}),
      event_type: "llm_call",
      span_id: spanId,
      attributes: {
        llm_call: {
          model: options.model,
          input: normalizedInput,
          output: options.output || null,
          input_tokens: options.inputTokens || null,
          output_tokens: options.outputTokens || null,
          total_tokens: options.totalTokens || null,
          latency_ms: options.latencyMs,
          time_to_first_token_ms: options.timeToFirstTokenMs || null,
          streaming_duration_ms: options.streamingDurationMs || null,
          finish_reason: options.finishReason || null,
          response_id: options.responseId || null,
          system_fingerprint: options.systemFingerprint || null,
          cost: options.cost || null,
          temperature: options.temperature || null,
          max_tokens: options.maxTokens || null,
          // TIER 1: OTEL Semantic Conventions
          operation_name: operationName,
          provider_name: providerName || null,
          response_model: options.responseModel || null,
          // TIER 2: Sampling parameters
          top_k: options.topK || null,
          top_p: options.topP || null,
          frequency_penalty: options.frequencyPenalty || null,
          presence_penalty: options.presencePenalty || null,
          stop_sequences: options.stopSequences || null,
          seed: options.seed || null,
          // TIER 2: Structured cost tracking
          input_cost: options.inputCost || null,
          output_cost: options.outputCost || null,
          // TIER 1: Structured message objects
          input_messages: options.inputMessages || null,
          output_messages: options.outputMessages || null,
          system_instructions: options.systemInstructions || null,
          // TIER 2: Server metadata
          server_address: options.serverAddress || null,
          server_port: options.serverPort || null,
          // TIER 2: Conversation grouping
          conversation_id_otel: options.conversationIdOtel || null,
          choice_count: options.choiceCount || null,
          // CRITICAL: Status field to mark errors (backend will use this to set span status)
          status: isError ? "error" : "success",
        },
        // Add metadata at top level of attributes (matching Langfuse format)
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
    });

    // Register LLM span for trace so feedback can validate parentSpanId
    const traceIdForSpan = options.traceId ?? this.currentTraceId ?? null;
    this.registerSpanForTrace(traceIdForSpan, spanId);

    return spanId;
  }

  /**
   * Track a tool call with OTEL standardization
   */
  trackToolCall(options: {
    toolName: string;
    args?: Record<string, any>;
    result?: any;
    resultStatus: "success" | "error" | "timeout";
    latencyMs: number;
    errorMessage?: string;
    // Optional linkage
    parentSpanId?: string | null;
    traceId?: string | null;
    // TIER 2: OTEL Tool Standardization
    operationName?: "execute_tool" | string | null;
    toolType?: "function" | "extension" | "datastore" | string | null;
    toolDescription?: string | null;
    toolCallId?: string | null;
    errorType?: string | null;
    errorCategory?: string | null;
  }): string {
    const spanId = crypto.randomUUID();

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:trackToolCall",
        message: "trackToolCall called",
        data: {
          toolName: options.toolName,
          instanceId: this.instanceId,
          currentTraceId: this.currentTraceId,
          spanStackDepth: this.spanStack.length,
          eventBufferSize: this.eventBuffer.length,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "G",
      }),
    }).catch(() => {});
    // #endregion

    this.addEvent({
      ...(options.traceId ? { trace_id: options.traceId } : {}),
      event_type: "tool_call",
      span_id: spanId,
      parent_span_id: options.parentSpanId ?? null,
      attributes: {
        tool_call: {
          tool_name: options.toolName,
          args: options.args || null,
          result: options.result || null,
          result_status: options.resultStatus,
          latency_ms: options.latencyMs,
          error_message: options.errorMessage || null,
          // TIER 2: OTEL Tool Standardization
          operation_name: options.operationName || "execute_tool",
          tool_type: options.toolType || null,
          tool_description: options.toolDescription || null,
          tool_call_id: options.toolCallId || null,
          error_type: options.errorType || null,
          error_category: options.errorCategory || null,
        },
      },
    });

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:trackToolCall",
        message: "trackToolCall addEvent completed",
        data: {
          toolName: options.toolName,
          instanceId: this.instanceId,
          currentTraceId: this.currentTraceId,
          spanStackDepth: this.spanStack.length,
          eventBufferSize: this.eventBuffer.length,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "G",
      }),
    }).catch(() => {});
    // #endregion

    return spanId;
  }

  /**
   * Track a retrieval operation with vector metadata enrichment
   */
  trackRetrieval(options: {
    contextIds?: string[];
    contextHashes?: string[];
    k?: number;
    similarityScores?: number[];
    latencyMs: number;
    // TIER 2: Retrieval enrichment
    retrievalContext?: string | null;
    embeddingModel?: string | null;
    embeddingDimensions?: number | null;
    vectorMetric?: "cosine" | "euclidean" | "dot_product" | string | null;
    rerankScore?: number | null;
    fusionMethod?: string | null;
    deduplicationRemovedCount?: number | null;
    qualityScore?: number | null;
  }): string {
    const spanId = crypto.randomUUID();

    this.addEvent({
      event_type: "retrieval",
      span_id: spanId,
      attributes: {
        retrieval: {
          retrieval_context_ids: options.contextIds || null,
          retrieval_context_hashes: options.contextHashes || null,
          k: options.k || null,
          top_k: options.k || null,
          similarity_scores: options.similarityScores || null,
          latency_ms: options.latencyMs,
          // TIER 2: Retrieval enrichment
          retrieval_context: options.retrievalContext || null,
          embedding_model: options.embeddingModel || null,
          embedding_dimensions: options.embeddingDimensions || null,
          vector_metric: options.vectorMetric || null,
          rerank_score: options.rerankScore || null,
          fusion_method: options.fusionMethod || null,
          deduplication_removed_count:
            options.deduplicationRemovedCount || null,
          quality_score: options.qualityScore || null,
        },
      },
    });

    return spanId;
  }

  /**
   * Track an error with structured error classification
   */
  trackError(options: {
    errorType: string;
    errorMessage: string;
    stackTrace?: string;
    context?: Record<string, any>;
    error?: Error; // Optional Error object - will extract stack trace if provided
    // TIER 2: Structured error classification
    errorCategory?: string | null;
    errorCode?: string | null;
  }): string {
    const spanId = crypto.randomUUID();

    // Extract stack trace from Error object if provided
    let stackTrace = options.stackTrace;
    if (!stackTrace && options.error instanceof Error && options.error.stack) {
      stackTrace = options.error.stack;
    }

    const baseProps = this.createBaseEventProperties();

    // Mark this trace as having an error (for automatic trace_end generation)
    this.tracesWithErrors.add(baseProps.trace_id);

    this.addEvent({
      event_type: "error",
      span_id: spanId,
      attributes: {
        error: {
          error_type: options.errorType,
          error_message: options.errorMessage,
          stack_trace: stackTrace || null,
          context: options.context || null,
          // TIER 2: Structured error classification
          error_category: options.errorCategory || null,
          error_code: options.errorCode || null,
        },
      },
    });

    return spanId;
  }

  /**
   * Track user feedback
   */
  trackFeedback(options: {
    type: "like" | "dislike" | "rating" | "correction";
    rating?: number; // 1-5 scale for rating type
    comment?: string;
    outcome?: "success" | "failure" | "partial";
    // Optional context to tie feedback to user/session/conversation
    conversationId?: string;
    sessionId?: string;
    userId?: string;
    messageIndex?: number;
    parentMessageId?: string;
    agentName?: string;
    version?: string;
    route?: string;
    // Optional linkage: attach under an existing span
    parentSpanId?: string | null;
    spanId?: string; // provide to control span id for feedback
    traceId?: string | null; // provide to attach to an existing trace
  }): string {
    const spanId = options.spanId || crypto.randomUUID();
    // CRITICAL: Do NOT default to spanStack for feedback.
    // Feedback is often submitted asynchronously and spanStack may point to a previous message.
    // Only attach to a span when parentSpanId is explicitly provided by the caller.
    let parentSpanId: string | null = (options.parentSpanId ?? null) as
      | string
      | null;

    // Validate parentSpanId belongs to the same trace if traceId is provided
    if (parentSpanId && options.traceId) {
      const knownSpans = this.traceSpanIds.get(options.traceId);
      if (knownSpans && !knownSpans.has(parentSpanId)) {
        console.warn(
          "[Observa SDK] trackFeedback: parentSpanId does not belong to traceId. " +
            "Ignoring parentSpanId to avoid attaching feedback to wrong message.",
          {
            traceId: options.traceId,
            parentSpanId,
          }
        );
        parentSpanId = null;
      }
    }

    // Clamp rating to 1-5 if provided
    let rating: number | null | undefined = options.rating;
    if (rating !== undefined && rating !== null) {
      rating = Math.max(1, Math.min(5, rating));
    }

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:trackFeedback",
        message: "trackFeedback called",
        data: {
          instanceId: this.instanceId,
          currentTraceId: this.currentTraceId,
          spanStackDepth: this.spanStack.length,
          eventBufferSize: this.eventBuffer.length,
          type: options.type,
          hasParentSpanId: !!options.parentSpanId,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "L",
      }),
    }).catch(() => {});
    // #endregion

    this.addEvent({
      ...(options.traceId ? { trace_id: options.traceId } : {}),
      event_type: "feedback",
      span_id: spanId,
      parent_span_id: parentSpanId ?? null,
      conversation_id: options.conversationId ?? null,
      session_id: options.sessionId ?? null,
      user_id: options.userId ?? null,
      agent_name: options.agentName ?? null,
      version: options.version ?? null,
      route: options.route ?? null,
      attributes: {
        feedback: {
          type: options.type,
          rating: rating ?? null,
          comment: options.comment || null,
          outcome: options.outcome || null,
        },
      },
    });

    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:trackFeedback",
        message: "trackFeedback addEvent completed",
        data: {
          instanceId: this.instanceId,
          currentTraceId: this.currentTraceId,
          spanStackDepth: this.spanStack.length,
          eventBufferSize: this.eventBuffer.length,
          type: options.type,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "L",
      }),
    }).catch(() => {});
    // #endregion

    return spanId;
  }

  /**
   * Convenience method to track "like" feedback
   * Shortcut for trackFeedback({ type: "like", outcome: "success", ... })
   */
  like(options?: {
    comment?: string;
    conversationId?: string;
    sessionId?: string;
    userId?: string;
    messageIndex?: number;
    parentMessageId?: string;
    agentName?: string;
    version?: string;
    route?: string;
    parentSpanId?: string | null;
    spanId?: string;
    traceId?: string | null;
  }): string {
    return this.trackFeedback({
      type: "like",
      outcome: "success",
      ...options,
    });
  }

  /**
   * Convenience method to track "dislike" feedback
   * Shortcut for trackFeedback({ type: "dislike", outcome: "failure", ... })
   */
  dislike(options?: {
    comment?: string;
    conversationId?: string;
    sessionId?: string;
    userId?: string;
    messageIndex?: number;
    parentMessageId?: string;
    agentName?: string;
    version?: string;
    route?: string;
    parentSpanId?: string | null;
    spanId?: string;
    traceId?: string | null;
  }): string {
    return this.trackFeedback({
      type: "dislike",
      outcome: "failure",
      ...options,
    });
  }

  /**
   * Track final output
   */
  trackOutput(options: {
    finalOutput?: string;
    outputLength?: number;
  }): string {
    const spanId = crypto.randomUUID();

    this.addEvent({
      event_type: "output",
      span_id: spanId,
      attributes: {
        output: {
          final_output: options.finalOutput || null,
          output_length: options.outputLength || null,
        },
      },
    });

    return spanId;
  }

  /**
   * Track an embedding operation (TIER 1: Critical)
   */
  trackEmbedding(options: {
    model: string;
    dimensionCount?: number | null;
    encodingFormats?: string[] | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    latencyMs: number;
    cost?: number | null;
    inputText?: string | null;
    inputHash?: string | null;
    embeddings?: number[][] | null;
    embeddingsHash?: string | null;
    operationName?: "embeddings" | string | null;
    providerName?: string | null;
  }): string {
    const spanId = crypto.randomUUID();

    // Auto-infer provider from model if not provided
    let providerName = options.providerName;
    if (!providerName && options.model) {
      const modelLower = options.model.toLowerCase();
      if (
        modelLower.includes("text-embedding") ||
        modelLower.includes("openai")
      ) {
        providerName = "openai";
      } else if (
        modelLower.includes("textembedding") ||
        modelLower.includes("google")
      ) {
        providerName = "google";
      } else if (modelLower.includes("vertex")) {
        providerName = "gcp.vertex_ai";
      }
    }

    this.addEvent({
      event_type: "embedding",
      span_id: spanId,
      attributes: {
        embedding: {
          model: options.model,
          dimension_count: options.dimensionCount || null,
          encoding_formats: options.encodingFormats || null,
          input_tokens: options.inputTokens || null,
          output_tokens: options.outputTokens || null,
          latency_ms: options.latencyMs,
          cost: options.cost || null,
          input_text: options.inputText || null,
          input_hash: options.inputHash || null,
          embeddings: options.embeddings || null,
          embeddings_hash: options.embeddingsHash || null,
          operation_name: options.operationName || "embeddings",
          provider_name: providerName || null,
        },
      },
    });

    return spanId;
  }

  /**
   * Track a vector database operation (TIER 3)
   */
  trackVectorDbOperation(options: {
    operationType: "vector_search" | "index_upsert" | "delete" | string;
    indexName?: string | null;
    indexVersion?: string | null;
    vectorDimensions?: number | null;
    vectorMetric?: "cosine" | "euclidean" | "dot_product" | string | null;
    resultsCount?: number | null;
    scores?: number[] | null;
    latencyMs: number;
    cost?: number | null;
    apiVersion?: string | null;
    providerName?: string | null; // e.g., "pinecone", "weaviate", "qdrant"
  }): string {
    const spanId = crypto.randomUUID();

    this.addEvent({
      event_type: "vector_db_operation",
      span_id: spanId,
      attributes: {
        vector_db_operation: {
          operation_type: options.operationType,
          index_name: options.indexName || null,
          index_version: options.indexVersion || null,
          vector_dimensions: options.vectorDimensions || null,
          vector_metric: options.vectorMetric || null,
          results_count: options.resultsCount || null,
          scores: options.scores || null,
          latency_ms: options.latencyMs,
          cost: options.cost || null,
          api_version: options.apiVersion || null,
          provider_name: options.providerName || null,
        },
      },
    });

    return spanId;
  }

  /**
   * Track a cache operation (TIER 3)
   */
  trackCacheOperation(options: {
    cacheBackend?: "redis" | "in_memory" | "memcached" | string | null;
    cacheKey?: string | null;
    cacheNamespace?: string | null;
    hitStatus: "hit" | "miss";
    latencyMs: number;
    savedCost?: number | null;
    ttl?: number | null;
    evictionInfo?: Record<string, any> | null;
  }): string {
    const spanId = crypto.randomUUID();

    this.addEvent({
      event_type: "cache_operation",
      span_id: spanId,
      attributes: {
        cache_operation: {
          cache_backend: options.cacheBackend || null,
          cache_key: options.cacheKey || null,
          cache_namespace: options.cacheNamespace || null,
          hit_status: options.hitStatus,
          latency_ms: options.latencyMs,
          saved_cost: options.savedCost || null,
          ttl: options.ttl || null,
          eviction_info: options.evictionInfo || null,
        },
      },
    });

    return spanId;
  }

  /**
   * Track agent creation (TIER 3)
   */
  trackAgentCreate(options: {
    agentName: string;
    agentConfig?: Record<string, any> | null;
    toolsBound?: string[] | null;
    modelConfig?: Record<string, any> | null;
    operationName?: "create_agent" | string | null;
  }): string {
    const spanId = crypto.randomUUID();

    this.addEvent({
      event_type: "agent_create",
      span_id: spanId,
      attributes: {
        agent_create: {
          agent_name: options.agentName,
          agent_config: options.agentConfig || null,
          tools_bound: options.toolsBound || null,
          model_config: options.modelConfig || null,
          operation_name: options.operationName || "create_agent",
        },
      },
    });

    return spanId;
  }

  /**
   * Execute a function within a span context (for nested operations)
   * This allows tool calls to be nested under LLM calls, etc.
   */
  withSpan<T>(spanId: string, fn: () => T): T {
    this.spanStack.push(spanId);
    try {
      return fn();
    } finally {
      this.spanStack.pop();
    }
  }

  /**
   * Execute an async function within a span context (for nested operations)
   */
  async withSpanAsync<T>(spanId: string, fn: () => Promise<T>): Promise<T> {
    this.spanStack.push(spanId);
    try {
      return await fn();
    } finally {
      this.spanStack.pop();
    }
  }

  /**
   * End trace and send events (manual trace management)
   */
  async endTrace(
    options: {
      outcome?: "success" | "error" | "timeout";
    } = {}
  ): Promise<string> {
    if (!this.currentTraceId || !this.rootSpanId) {
      throw new Error("[Observa] No active trace. Call startTrace() first.");
    }

    // Calculate summary statistics from buffered events for this trace
    const traceEvents = this.eventBuffer.filter(
      (e) => e.trace_id === this.currentTraceId
    );
    const llmEvents = traceEvents.filter((e) => e.event_type === "llm_call");
    const totalTokens = llmEvents.reduce(
      (sum, e) => sum + (e.attributes.llm_call?.total_tokens || 0),
      0
    );
    const totalCost = llmEvents.reduce(
      (sum, e) => sum + (e.attributes.llm_call?.cost || 0),
      0
    );

    // Calculate total latency
    const totalLatency =
      this.traceStartTime !== null ? Date.now() - this.traceStartTime : null;

    // Add trace_end event
    this.addEvent({
      event_type: "trace_end",
      span_id: this.rootSpanId,
      parent_span_id: null,
      attributes: {
        trace_end: {
          total_latency_ms: totalLatency,
          total_tokens: totalTokens || null,
          total_cost: totalCost || null,
          outcome: options.outcome || "success",
        },
      },
    });

    // Get all events for this trace
    const traceEventsToSend = this.eventBuffer.filter(
      (e) => e.trace_id === this.currentTraceId
    );
    // #region agent log
    const traceEventTypeCounts: Record<string, number> = {};
    for (const evt of traceEventsToSend) {
      traceEventTypeCounts[evt.event_type] =
        (traceEventTypeCounts[evt.event_type] || 0) + 1;
    }
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:endTrace",
        message: "traceEventsToSend summary",
        data: {
          traceId: this.currentTraceId,
          eventCount: traceEventsToSend.length,
          eventTypes: traceEventTypeCounts,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "I",
      }),
    }).catch(() => {});
    // #endregion

    // Send events (this will flush them)
    if (traceEventsToSend.length > 0) {
      await this._sendEventsWithRetry(traceEventsToSend);
      // Remove sent events from buffer
      this.eventBuffer = this.eventBuffer.filter(
        (e) => e.trace_id !== this.currentTraceId
      );
    }

    // Reset trace state
    const traceId = this.currentTraceId;
    this.currentTraceId = null;
    this.rootSpanId = null;
    this.spanStack = [];
    this.traceStartTime = null;

    return traceId;
  }

  /**
   * Internal flush implementation
   */
  private async _doFlush(): Promise<void> {
    const eventsToFlush = [...this.eventBuffer];
    this.eventBuffer = [];

    if (eventsToFlush.length === 0) {
      return;
    }

    const activeTraceId = this.currentTraceId;
    const activeTraceEvents: CanonicalEvent[] = [];
    const otherEvents: CanonicalEvent[] = [];
    for (const event of eventsToFlush) {
      if (activeTraceId && event.trace_id === activeTraceId) {
        activeTraceEvents.push(event);
      } else {
        otherEvents.push(event);
      }
    }

    if (activeTraceEvents.length > 0) {
      // Keep active trace events buffered until endTrace is called.
      this.eventBuffer.unshift(...activeTraceEvents);
    }

    if (otherEvents.length === 0) {
      return;
    }

    // Send events in batches (group by trace_id to send complete traces)
    const eventsByTrace = new Map<string, CanonicalEvent[]>();
    for (const event of otherEvents) {
      if (!eventsByTrace.has(event.trace_id)) {
        eventsByTrace.set(event.trace_id, []);
      }
      eventsByTrace.get(event.trace_id)!.push(event);
    }

    // For each trace, ensure trace_start and trace_end events exist
    // This is critical for instrumentation usage without explicit trace management
    for (const [traceId, events] of eventsByTrace.entries()) {
      const hasTraceStart = events.some((e) => e.event_type === "trace_start");
      const hasTraceEnd = events.some((e) => e.event_type === "trace_end");
      const hasError = this.tracesWithErrors.has(traceId);
      const rootSpanId =
        this.traceRootSpanIds.get(traceId) ||
        events[0]?.span_id ||
        crypto.randomUUID();

      // Get base properties from first event (all events in a trace share tenant/project/env)
      const firstEvent = events[0];
      if (!firstEvent) continue;

      // If no trace_start exists, create one (happens when using instrumentation without startTrace)
      if (!hasTraceStart) {
        const traceStartEvent: CanonicalEvent = {
          tenant_id: firstEvent.tenant_id,
          project_id: firstEvent.project_id,
          environment: firstEvent.environment,
          trace_id: traceId,
          span_id: rootSpanId,
          parent_span_id: null,
          timestamp: firstEvent.timestamp,
          event_type: "trace_start",
          attributes: {
            trace_start: {
              name: null,
              metadata: null,
            },
          },
        };
        events.unshift(traceStartEvent); // Add at beginning
      }

      // If no trace_end exists, create one with appropriate outcome
      if (!hasTraceEnd) {
        // Calculate summary statistics
        const llmEvents = events.filter((e) => e.event_type === "llm_call");
        const totalTokens = llmEvents.reduce(
          (sum, e) => sum + (e.attributes.llm_call?.total_tokens || 0),
          0
        );
        const totalCost = llmEvents.reduce(
          (sum, e) => sum + (e.attributes.llm_call?.cost || 0),
          0
        );

        // Calculate total latency from first to last event
        const timestamps = events
          .map((e) => new Date(e.timestamp).getTime())
          .filter(Boolean);
        const totalLatency =
          timestamps.length > 0
            ? Math.max(...timestamps) - Math.min(...timestamps)
            : null;

        const traceEndEvent: CanonicalEvent = {
          tenant_id: firstEvent.tenant_id,
          project_id: firstEvent.project_id,
          environment: firstEvent.environment,
          trace_id: traceId,
          span_id: rootSpanId,
          parent_span_id: null,
          timestamp: new Date().toISOString(),
          event_type: "trace_end",
          attributes: {
            trace_end: {
              total_latency_ms: totalLatency,
              total_tokens: totalTokens || null,
              total_cost: totalCost || null,
              outcome: hasError ? "error" : "success",
            },
          },
        };
        events.push(traceEndEvent); // Add at end
      }

      // Clean up tracking maps after flushing
      this.tracesWithErrors.delete(traceId);
      this.traceRootSpanIds.delete(traceId);

      await this._sendEventsWithRetry(events);
    }
  }

  /**
   * Send canonical events with exponential backoff retry
   */
  private async _sendEventsWithRetry(
    events: CanonicalEvent[],
    maxRetries: number = 3
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.sendEvents(events);
        return; // Success
      } catch (error) {
        if (attempt === maxRetries) {
          // Final attempt failed - re-buffer for later
          console.error(
            `[Observa] Failed to send events after ${
              maxRetries + 1
            } attempts, re-buffering:`,
            error
          );
          this.eventBuffer.push(...events);
          // Prevent buffer from growing too large
          if (this.eventBuffer.length > this.maxBufferSize * 2) {
            // Drop oldest events
            const toDrop = this.eventBuffer.length - this.maxBufferSize;
            this.eventBuffer.splice(0, toDrop);
          }
          return;
        }

        // Exponential backoff: 100ms, 200ms, 400ms
        const delayMs = 100 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Cleanup (call when shutting down)
   */
  async end(): Promise<void> {
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }

    // Flush remaining events
    await this.flush();
  }

  /**
   * Observe OpenAI client - wraps client with automatic tracing
   *
   * @param client - OpenAI client instance
   * @param options - Observation options (name, tags, userId, sessionId, redact)
   * @returns Wrapped OpenAI client
   *
   * @example
   * ```typescript
   * import OpenAI from 'openai';
   * const openai = new OpenAI({ apiKey: '...' });
   * const wrapped = observa.observeOpenAI(openai, {
   *   name: 'my-app',
   *   redact: (data) => ({ ...data, messages: '[REDACTED]' })
   * });
   * ```
   */
  observeOpenAI(
    client: any,
    options?: {
      name?: string;
      tags?: string[];
      userId?: string;
      sessionId?: string;
      redact?: (data: any) => any;
    }
  ): any {
    try {
      // Use static import - tsup bundles everything together
      // This works in both ESM and CommonJS when bundled
      return observeOpenAIFn(client, { ...options, observa: this });
    } catch (error) {
      // Fail gracefully - return unwrapped client
      console.error("[Observa] Failed to load OpenAI wrapper:", error);
      return client;
    }
  }

  /**
   * Observe Anthropic client - wraps client with automatic tracing
   *
   * @param client - Anthropic client instance
   * @param options - Observation options (name, tags, userId, sessionId, redact)
   * @returns Wrapped Anthropic client
   *
   * @example
   * ```typescript
   * import Anthropic from '@anthropic-ai/sdk';
   * const anthropic = new Anthropic({ apiKey: '...' });
   * const wrapped = observa.observeAnthropic(anthropic, {
   *   name: 'my-app',
   *   redact: (data) => ({ ...data, messages: '[REDACTED]' })
   * });
   * ```
   */
  observeAnthropic(
    client: any,
    options?: {
      name?: string;
      tags?: string[];
      userId?: string;
      sessionId?: string;
      redact?: (data: any) => any;
    }
  ): any {
    try {
      // Use static import - tsup bundles everything together
      // This works in both ESM and CommonJS when bundled
      return observeAnthropicFn(client, { ...options, observa: this });
    } catch (error) {
      // Fail gracefully - return unwrapped client
      console.error("[Observa] Failed to load Anthropic wrapper:", error);
      return client;
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
   * const observa = init({ apiKey: '...' });
   *
   * const ai = observa.observeVercelAI({ generateText, streamText }, {
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
  observeVercelAI(
    aiSdk: {
      generateText?: any;
      streamText?: any;
      [key: string]: any;
    },
    options?: {
      name?: string;
      tags?: string[];
      userId?: string;
      sessionId?: string;
      redact?: (data: any) => any;
    }
  ): any {
    try {
      // Use static import - tsup bundles everything together
      // This works in both ESM and CommonJS when bundled
      return observeVercelAIFn(aiSdk, { ...options, observa: this });
    } catch (error) {
      // Fail gracefully - return unwrapped SDK
      console.error("[Observa] Failed to load Vercel AI SDK wrapper:", error);
      return aiSdk;
    }
  }

  /**
   * Send canonical events to Observa backend
   * (internal method, use _sendEventsWithRetry for retry logic)
   */
  private async sendEvents(events: CanonicalEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    // #region agent log
    try {
      const eventTypes: Record<string, number> = {};
      let llmCount = 0;
      let toolCount = 0;
      let feedbackCount = 0;
      let llmWithCost = 0;
      let llmMissingModel = 0;
      let llmMissingInput = 0;
      let llmMissingOutput = 0;
      for (const evt of events) {
        eventTypes[evt.event_type] = (eventTypes[evt.event_type] || 0) + 1;
        if (evt.event_type === "llm_call") {
          llmCount += 1;
          const llmAttrs = (evt as any)?.attributes?.llm_call || {};
          const cost = llmAttrs?.cost;
          if (typeof cost === "number" && Number.isFinite(cost)) {
            llmWithCost += 1;
          }
          if (!llmAttrs?.model || llmAttrs.model === "unknown") {
            llmMissingModel += 1;
          }
          if (
            llmAttrs?.input === null ||
            (typeof llmAttrs?.input === "string" && llmAttrs.input.length === 0)
          ) {
            llmMissingInput += 1;
          }
          if (
            llmAttrs?.output === null ||
            (typeof llmAttrs?.output === "string" &&
              llmAttrs.output.length === 0)
          ) {
            llmMissingOutput += 1;
          }
        } else if (evt.event_type === "tool_call") {
          toolCount += 1;
        } else if (evt.event_type === "feedback") {
          feedbackCount += 1;
        }
      }
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "index.ts:sendEvents",
            message: "pre-send event summary",
            data: {
              eventCount: events.length,
              eventTypes,
              llmCount,
              toolCount,
              feedbackCount,
              llmWithCost,
              llmMissingModel,
              llmMissingInput,
              llmMissingOutput,
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "A",
          }),
        }
      ).catch(() => {});
    } catch {
      // ignore debug logging errors
    }
    // #endregion
    // #region agent log
    const sendEventTypeCounts: Record<string, number> = {};
    for (const evt of events) {
      sendEventTypeCounts[evt.event_type] =
        (sendEventTypeCounts[evt.event_type] || 0) + 1;
    }
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:sendEvents",
        message: "sending events summary",
        data: {
          traceId: events[0]?.trace_id,
          eventCount: events.length,
          eventTypes: sendEventTypeCounts,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "I",
      }),
    }).catch(() => {});
    // #endregion

    // For backward compatibility, show pretty logs in dev mode
    // Extract first trace_id for logging
    const traceId = events[0]?.trace_id;
    if (!this.isProduction && traceId) {
      // Try to reconstruct TraceData for pretty logging (backward compatibility)
      const llmEvent = events.find((e) => e.event_type === "llm_call");
      const outputEvent = events.find((e) => e.event_type === "output");
      const traceEndEvent = events.find((e) => e.event_type === "trace_end");

      if (llmEvent && outputEvent) {
        const llmAttrs = llmEvent.attributes.llm_call;
        const outputAttrs = outputEvent.attributes.output;
        const traceData: TraceData = {
          traceId: llmEvent.trace_id,
          spanId: llmEvent.parent_span_id || llmEvent.span_id,
          parentSpanId: llmEvent.parent_span_id || null,
          timestamp: llmEvent.timestamp,
          tenantId: llmEvent.tenant_id,
          projectId: llmEvent.project_id,
          environment: llmEvent.environment,
          query: llmAttrs?.input || "",
          response: outputAttrs?.final_output || "",
          responseLength: outputAttrs?.output_length || 0,
          ...(llmAttrs?.model && { model: llmAttrs.model }),
          tokensPrompt: llmAttrs?.input_tokens ?? null,
          tokensCompletion: llmAttrs?.output_tokens ?? null,
          tokensTotal: llmAttrs?.total_tokens ?? null,
          latencyMs: llmAttrs?.latency_ms || 0,
          timeToFirstTokenMs: llmAttrs?.time_to_first_token_ms ?? null,
          streamingDurationMs: llmAttrs?.streaming_duration_ms ?? null,
          finishReason: llmAttrs?.finish_reason ?? null,
          responseId: llmAttrs?.response_id ?? null,
          systemFingerprint: llmAttrs?.system_fingerprint ?? null,
          ...(llmEvent.conversation_id && {
            conversationId: llmEvent.conversation_id,
          }),
          ...(llmEvent.session_id && { sessionId: llmEvent.session_id }),
          ...(llmEvent.user_id && { userId: llmEvent.user_id }),
        };

        formatBeautifulLog(traceData);
      }
    }

    // Send to Observa backend (canonical events endpoint)
    try {
      // Remove trailing slash from apiUrl if present, then add the path
      const baseUrl = this.apiUrl.replace(/\/+$/, "");
      const url = `${baseUrl}/api/v1/events/ingest`;

      // Enhanced logging for debugging
      console.log(
        `[Observa] Sending ${
          events.length
        } canonical events - URL: ${url}, TraceID: ${traceId}, Tenant: ${
          events[0]?.tenant_id
        }, Project: ${events[0]?.project_id}, APIKey: ${
          this.apiKey ? `Yes(${this.apiKey.length} chars)` : "No"
        }`
      );

      // Add timeout to prevent hanging requests (10 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(events),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "index.ts:sendEvents",
              message: "ingest response status",
              data: {
                status: response.status,
                statusText: response.statusText,
                url,
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "G",
            }),
          }
        ).catch(() => {});
        // #endregion

        // Always log response status for debugging
        console.log(
          `[Observa] Response status: ${response.status} ${response.statusText}`
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          let errorJson: any;
          try {
            errorJson = JSON.parse(errorText);
          } catch {
            errorJson = { error: errorText };
          }

          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:sendEvents",
                message: "ingest error response",
                data: {
                  status: response.status,
                  statusText: response.statusText,
                  errorPreview:
                    typeof errorText === "string"
                      ? errorText.substring(0, 300)
                      : null,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "G",
              }),
            }
          ).catch(() => {});
          // #endregion

          console.error(
            `[Observa] Backend API error: ${response.status} ${response.statusText}`,
            errorJson.error || errorText
          );
          throw new Error(
            `Observa API error: ${response.status} ${
              errorJson.error?.message || errorText
            }`
          );
        } else {
          const result = await response.json().catch(() => ({}));
          // Log success even in production for debugging
          console.log(
            `✅ [Observa] Events sent successfully - Trace ID: ${traceId}, Event count: ${
              result.event_count || events.length
            }`
          );
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === "AbortError") {
          console.error("[Observa] Request timeout after 10 seconds");
        }
        throw fetchError;
      }
    } catch (error) {
      // Enhanced error logging
      console.error("[Observa] Failed to send events:", error);
      if (error instanceof Error) {
        console.error("[Observa] Error message:", error.message);
        console.error("[Observa] Error name:", error.name);
        if (error.name === "AbortError") {
          console.error(
            "[Observa] Request timed out - check network connectivity and API URL"
          );
        }
        if (error.stack) {
          console.error("[Observa] Error stack:", error.stack);
        }
      }
      throw error;
    }
  }
}

// factory
export const init = (config: ObservaInitConfig) => new Observa(config);
