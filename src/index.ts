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
import { observeLangChain as observeLangChainFn } from "./instrumentation/langchain.js";

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
      tool_definitions?: Array<Record<string, any>> | null;
      tools?: Array<Record<string, any>> | null;
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
    color: string = colors.cyan,
  ) => `${colors.dim}${label}:${colors.reset} ${color}${value}${colors.reset}`;

  console.log("\n" + "═".repeat(90));
  console.log(
    `${colors.bright}${colors.blue}🔍 OBSERVA TRACE${colors.reset} ${colors.gray}${trace.traceId}${colors.reset}`,
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
      colors.gray,
    )}`,
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
    `  ${formatValue("Latency", `${trace.latencyMs}ms`, colors.green)}`,
  );
  if (trace.timeToFirstTokenMs != null) {
    console.log(
      `  ${formatValue("TTFB", `${trace.timeToFirstTokenMs}ms`, colors.cyan)}`,
    );
  }
  if (trace.streamingDurationMs != null) {
    console.log(
      `  ${formatValue(
        "Streaming",
        `${trace.streamingDurationMs}ms`,
        colors.cyan,
      )}`,
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
        colors.bright + colors.yellow,
      )}`,
    );

  console.log(`\n${colors.bright}📤 Response${colors.reset}`);
  console.log(
    `  ${formatValue(
      "Length",
      `${trace.responseLength.toLocaleString()} chars`,
      colors.cyan,
    )}`,
  );
  if (trace.status != null) {
    const statusColor =
      trace.status >= 200 && trace.status < 300 ? colors.green : colors.yellow;
    console.log(
      `  ${formatValue(
        "Status",
        `${trace.status} ${trace.statusText ?? ""}`,
        statusColor,
      )}`,
    );
  }
  if (trace.finishReason)
    console.log(
      `  ${formatValue("Finish", trace.finishReason, colors.magenta)}`,
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
      const valueStr = typeof v === "object" ? safeJsonStringify(v) : String(v);
      console.log(`  ${formatValue(k, valueStr, colors.gray)}`);
    }
  }

  console.log("═".repeat(90) + "\n");
}

// Escape control characters and invalid surrogates for safe JSON storage
function escapeControlChars(value: string): string {
  const withoutLoneSurrogates = value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );

  return withoutLoneSurrogates.replace(
    /[\u0000-\u001F\u2028\u2029]/g,
    (char) => {
      switch (char) {
        case "\b":
          return "\\b";
        case "\f":
          return "\\f";
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        case "\u2028":
          return "\\u2028";
        case "\u2029":
          return "\\u2029";
        default: {
          const code = char.charCodeAt(0).toString(16).padStart(4, "0");
          return `\\u${code}`;
        }
      }
    },
  );
}

function truncateString(value: string, maxLength?: number): string {
  if (!maxLength || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function sanitizeAttributesForStorage(
  value: any,
  seen: WeakSet<object> = new WeakSet(),
  maxStringLength?: number,
): any {
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === "string") {
    // Final safety check: if this string looks like malformed JSON arguments
    // (pattern: "key":"value" without outer braces), try to fix it
    // This catches cases where normalization might have been bypassed
    const trimmed = value.trim();
    if (
      trimmed.startsWith('"') &&
      !trimmed.startsWith('"{') &&
      trimmed.includes(":") &&
      trimmed.length > 3 // At least "a":b
    ) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "index.ts:sanitizeAttributesForStorage:safetyCheck",
            message: "Safety check triggered - found malformed JSON string",
            data: {
              stringValue: trimmed.substring(0, 200),
              stringLength: trimmed.length,
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "F",
          }),
        },
      ).catch(() => {});
      // #endregion

      // This might be a malformed JSON object string - try to normalize it
      try {
        const normalized = normalizeToolArguments(value);
        // If normalization succeeded and returned an object, use that instead
        if (typeof normalized !== "string") {
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location:
                  "index.ts:sanitizeAttributesForStorage:safetyCheckSuccess",
                message: "Safety check fixed malformed string",
                data: {
                  original: trimmed.substring(0, 100),
                  normalizedType: typeof normalized,
                  normalizedPreview: JSON.stringify(normalized).substring(
                    0,
                    100,
                  ),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "F",
              }),
            },
          ).catch(() => {});
          // #endregion
          return sanitizeAttributesForStorage(
            normalized,
            seen,
            maxStringLength,
          );
        }
      } catch (e) {
        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location:
                "index.ts:sanitizeAttributesForStorage:safetyCheckFailed",
              message: "Safety check failed to fix malformed string",
              data: {
                error: String(e),
                stringValue: trimmed.substring(0, 200),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "F",
            }),
          },
        ).catch(() => {});
        // #endregion
        // If normalization fails, proceed with original string
      }
    }
    return truncateString(escapeControlChars(value), maxStringLength);
  }
  if (valueType === "number" || valueType === "boolean") {
    return value;
  }
  if (valueType === "bigint") {
    return value.toString();
  }
  if (valueType === "function") {
    return "[function]";
  }
  if (valueType === "symbol") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeAttributesForStorage(item, seen, maxStringLength),
    );
  }

  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([key, val]) => [
      sanitizeAttributesForStorage(key, seen, maxStringLength),
      sanitizeAttributesForStorage(val, seen, maxStringLength),
    ]);
  }
  if (value instanceof Set) {
    return Array.from(value.values()).map((val) =>
      sanitizeAttributesForStorage(val, seen, maxStringLength),
    );
  }

  if (value && valueType === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    const sanitized: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      // Special handling for function_call.arguments and tool_calls[].function.arguments
      // to catch any malformed strings that bypassed normalization
      if (
        (key === "function_call" &&
          val &&
          typeof val === "object" &&
          "arguments" in val) ||
        (key === "additional_kwargs" && val && typeof val === "object")
      ) {
        // Recursively sanitize, but arguments will be caught by the string check above
        sanitized[key] = sanitizeAttributesForStorage(
          val,
          seen,
          maxStringLength,
        );
      } else if (key === "tool_calls" && Array.isArray(val)) {
        // Handle tool_calls array - each may have function.arguments
        sanitized[key] = val.map((tc: any) => {
          if (
            tc &&
            typeof tc === "object" &&
            tc.function &&
            typeof tc.function === "object" &&
            "arguments" in tc.function
          ) {
            // The arguments will be caught by the string check in sanitizeAttributesForStorage
            return sanitizeAttributesForStorage(tc, seen, maxStringLength);
          }
          return sanitizeAttributesForStorage(tc, seen, maxStringLength);
        });
      } else {
        sanitized[key] = sanitizeAttributesForStorage(
          val,
          seen,
          maxStringLength,
        );
      }
    }
    return sanitized;
  }

  try {
    return truncateString(escapeControlChars(String(value)), maxStringLength);
  } catch {
    return null;
  }
}

function safeJsonStringify(
  value: unknown,
  options: { maxStringLength?: number } = {},
): string {
  const seen = new WeakSet<object>();
  const maxStringLength = options.maxStringLength;

  return JSON.stringify(value, (_key, val) => {
    if (val === null || val === undefined) return val;
    const type = typeof val;

    if (type === "string") {
      return truncateString(escapeControlChars(val), maxStringLength);
    }
    if (type === "bigint") {
      return val.toString();
    }
    if (type === "function") {
      return "[function]";
    }
    if (type === "symbol") {
      return val.toString();
    }

    if (typeof val === "object") {
      if (seen.has(val)) {
        return "[circular]";
      }
      seen.add(val);

      if (val instanceof Map) {
        return Array.from(val.entries()).map(([key, mapVal]) => [key, mapVal]);
      }
      if (val instanceof Set) {
        return Array.from(val.values());
      }
    }

    return val;
  });
}

function toPlainJson<T>(value: T, maxStringLength?: number): T {
  try {
    const options = maxStringLength !== undefined ? { maxStringLength } : {};
    const stringified = safeJsonStringify(value, options);
    const parsed = JSON.parse(stringified) as T;

    // CRITICAL: Ensure arguments fields remain objects, not strings
    // This prevents cases where arguments objects get converted to malformed strings
    const ensureArgumentsAreObjects = (obj: any): any => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === "string") {
        // If a string looks like malformed JSON arguments, try to fix it
        const trimmed = obj.trim();
        if (
          trimmed.startsWith('"') &&
          !trimmed.startsWith('"{') &&
          trimmed.includes(":") &&
          trimmed.length > 3
        ) {
          try {
            const fixed = normalizeToolArguments(obj);
            if (typeof fixed !== "string") {
              return fixed;
            }
          } catch {
            // Ignore
          }
        }
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(ensureArgumentsAreObjects);
      }
      if (typeof obj === "object") {
        const result: Record<string, any> = {};
        for (const [key, val] of Object.entries(obj)) {
          if (key === "arguments" && typeof val === "string") {
            // Arguments should be an object, not a string
            const normalized = normalizeToolArguments(val);
            result[key] = typeof normalized === "string" ? val : normalized;
          } else if (
            key === "function_call" &&
            val &&
            typeof val === "object" &&
            "arguments" in val
          ) {
            result[key] = {
              ...val,
              arguments:
                typeof val.arguments === "string"
                  ? normalizeToolArguments(val.arguments) || val.arguments
                  : ensureArgumentsAreObjects(val.arguments),
            };
          } else if (
            key === "function" &&
            val &&
            typeof val === "object" &&
            "arguments" in val
          ) {
            result[key] = {
              ...val,
              arguments:
                typeof val.arguments === "string"
                  ? normalizeToolArguments(val.arguments) || val.arguments
                  : ensureArgumentsAreObjects(val.arguments),
            };
          } else {
            result[key] = ensureArgumentsAreObjects(val);
          }
        }
        return result;
      }
      return obj;
    };

    return ensureArgumentsAreObjects(parsed) as T;
  } catch {
    return value;
  }
}

function normalizeToolArguments(value: unknown): unknown {
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "index.ts:normalizeToolArguments:entry",
      message: "normalizeToolArguments called",
      data: {
        valueType: typeof value,
        valuePreview:
          typeof value === "string"
            ? value.substring(0, 200)
            : String(value).substring(0, 200),
        valueLength: typeof value === "string" ? value.length : 0,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "A,B,C",
    }),
  }).catch(() => {});
  // #endregion

  if (typeof value !== "string") {
    return value;
  }

  // If empty string, return as-is
  if (value.trim().length === 0) {
    return value;
  }

  try {
    // Try to parse as JSON first
    const parsed = JSON.parse(value);
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:normalizeToolArguments:parsed",
        message: "Successfully parsed as JSON",
        data: {
          parsedType: typeof parsed,
          parsedPreview: JSON.stringify(parsed).substring(0, 200),
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "A",
      }),
    }).catch(() => {});
    // #endregion
    return parsed;
  } catch (parseError) {
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:normalizeToolArguments:parseFailed",
        message: "JSON parse failed, attempting fixes",
        data: {
          error: String(parseError),
          valuePreview: value.substring(0, 200),
          startsWithDoubleQuote: value.trim().startsWith('""'),
          endsWithDoubleQuote: value.trim().endsWith('""'),
          hasColon: value.includes(":"),
          startsWithQuote: value.trim().startsWith('"'),
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion
    // If parsing fails, check if it looks like malformed JSON that we can fix
    const trimmed = value.trim();

    // Handle case where string is double-quoted (e.g., ""key":"value"")
    // This can happen when LangChain provides arguments that are incorrectly encoded
    if (trimmed.startsWith('""') && trimmed.endsWith('""')) {
      // Remove outer double quotes and try parsing the inner content
      const inner = trimmed.slice(1, -1);
      try {
        return JSON.parse(inner);
      } catch {
        // If inner still fails, it might be a JSON object missing braces
        // Try wrapping in braces: "key":"value" -> {"key":"value"}
        if (
          inner.includes(":") &&
          !inner.startsWith("{") &&
          !inner.startsWith("[")
        ) {
          try {
            return JSON.parse(`{${inner}}`);
          } catch {
            // If that also fails, try to fix common issues:
            // 1. The inner might be "key":"value" which needs braces
            // 2. Check if it's a valid JSON object structure
            if (inner.match(/^"[^"]+":/)) {
              // It looks like "key":... so try wrapping
              try {
                return JSON.parse(`{${inner}}`);
              } catch {
                // Last resort: return the original value
              }
            }
          }
        }
      }
    }

    // Handle case where string looks like a JSON object property but missing outer braces
    // Most common pattern: "query":"value" -> should be {"query":"value"}
    // CRITICAL: This pattern causes "arguments":""query":"value"" in final JSON
    // Try a simple approach: if it starts with " and has :, try wrapping in {}
    if (
      trimmed.startsWith('"') &&
      !trimmed.startsWith('"{') &&
      trimmed.includes(":")
    ) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "index.ts:normalizeToolArguments:attemptSimpleWrap",
            message: "Attempting simple wrap for malformed JSON pattern",
            data: {
              trimmed: trimmed.substring(0, 200),
              trimmedLength: trimmed.length,
              firstChar: trimmed[0],
              hasColon: trimmed.includes(":"),
              wrapped: `{${trimmed}}`.substring(0, 200),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "B",
          }),
        },
      ).catch(() => {});
      // #endregion

      // Try wrapping the entire string in braces
      try {
        const wrapped = `{${trimmed}}`;
        const parsed = JSON.parse(wrapped);
        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "index.ts:normalizeToolArguments:simpleWrapSuccess",
              message: "Successfully fixed by simple wrapping",
              data: {
                original: trimmed.substring(0, 100),
                wrapped: wrapped.substring(0, 100),
                parsedType: typeof parsed,
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          },
        ).catch(() => {});
        // #endregion
        return parsed;
      } catch (wrapError) {
        // #region agent log
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "index.ts:normalizeToolArguments:simpleWrapFailed",
              message: "Simple wrapping failed - this will cause JSON error",
              data: {
                error: String(wrapError),
                errorMessage:
                  wrapError instanceof Error
                    ? wrapError.message
                    : String(wrapError),
                trimmed: trimmed.substring(0, 200),
                wrapped: `{${trimmed}}`.substring(0, 200),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          },
        ).catch(() => {});
        // #endregion

        // If simple wrapping fails, try one more aggressive fix:
        // The string might be "key":"value" but with escaped quotes or special characters
        // Try to extract the key and value manually and reconstruct
        try {
          // More robust regex that handles quoted values with special characters
          // Pattern: "key":"value" where value can contain escaped quotes, colons, etc.
          // We need to find the key, then find the value (which might be quoted)
          const keyMatch = trimmed.match(/^"([^"]+)":\s*/);
          if (keyMatch && keyMatch[1]) {
            const key: string = keyMatch[1];
            const afterKey = trimmed.substring(keyMatch[0].length);

            let val: any = "";
            // Try to parse the value
            if (afterKey.startsWith('"')) {
              // Value is a quoted string - find the closing quote (handling escaped quotes)
              let endQuoteIndex = -1;
              let i = 1;
              while (i < afterKey.length) {
                if (afterKey[i] === '"' && afterKey[i - 1] !== "\\") {
                  endQuoteIndex = i;
                  break;
                }
                i++;
              }
              if (endQuoteIndex > 0) {
                val = afterKey.substring(1, endQuoteIndex);
                // Unescape the value
                val = val.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
              } else {
                // No closing quote found, take the rest
                val = afterKey.substring(1);
              }
            } else {
              // Value is not quoted - try to parse as JSON (number, boolean, null, etc.)
              try {
                val = JSON.parse(afterKey.trim());
              } catch {
                // If parsing fails, take the rest as string
                val = afterKey.trim();
              }
            }

            const reconstructed: Record<string, any> = { [key]: val };
            // #region agent log
            fetch(
              "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location:
                    "index.ts:normalizeToolArguments:reconstructSuccess",
                  message: "Successfully reconstructed from key-value pattern",
                  data: {
                    original: trimmed.substring(0, 100),
                    reconstructed: JSON.stringify(reconstructed).substring(
                      0,
                      100,
                    ),
                    key,
                    valuePreview: String(val).substring(0, 50),
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "B",
                }),
              },
            ).catch(() => {});
            // #endregion
            return reconstructed;
          }
        } catch (reconstructError) {
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:normalizeToolArguments:reconstructFailed",
                message: "Reconstruction failed",
                data: {
                  error: String(reconstructError),
                  trimmed: trimmed.substring(0, 200),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "B",
              }),
            },
          ).catch(() => {});
          // #endregion
        }

        // If all fixes fail, the string is likely malformed in a way we can't fix
        // Return as-is - it will be escaped by JSON.stringify but may still cause issues
        // Log a warning that this might cause problems
        console.warn(
          "[Observa] Failed to normalize malformed arguments string:",
          trimmed.substring(0, 100),
        );
      }
    }

    // Handle case where string looks like a JSON object property but missing outer braces
    // Example: "query":"value" (should be {"query":"value"})
    // Only attempt this if it clearly looks like a JSON object (has colon, starts with quote)
    if (
      trimmed.includes(":") &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[") &&
      trimmed.startsWith('"')
    ) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "index.ts:normalizeToolArguments:attemptWrap",
            message: "Attempting to wrap string in braces",
            data: {
              trimmed: trimmed.substring(0, 200),
              matchesPattern: !!trimmed.match(/^"[^"]+":/),
              wrapped: `{${trimmed}}`.substring(0, 200),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "B",
          }),
        },
      ).catch(() => {});
      // #endregion

      // Check if it matches the pattern "key": (with optional value)
      const keyPattern = /^"[^"]+":/;
      if (keyPattern.test(trimmed)) {
        try {
          // Try wrapping in braces
          const wrapped = `{${trimmed}}`;
          const parsed = JSON.parse(wrapped);
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:normalizeToolArguments:wrapSuccess",
                message: "Successfully wrapped and parsed",
                data: { parsedType: typeof parsed },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "B",
              }),
            },
          ).catch(() => {});
          // #endregion
          return parsed;
        } catch (wrapError) {
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:normalizeToolArguments:wrapFailed",
                message: "Wrapping in braces failed",
                data: {
                  error: String(wrapError),
                  wrapped: `{${trimmed}}`.substring(0, 200),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "B",
              }),
            },
          ).catch(() => {});
          // #endregion
          // Fall through - return original value
        }
      }
    }

    // If all parsing attempts fail, return the value as-is
    // JSON.stringify in sanitizeAttributesForStorage will properly escape it
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "index.ts:normalizeToolArguments:returnOriginal",
        message: "Returning original value (all fixes failed)",
        data: {
          valuePreview: value.substring(0, 200),
          valueLength: value.length,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion
    return value;
  }
}

function normalizeMessageToolCalls(message: any): any {
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "index.ts:normalizeMessageToolCalls:entry",
      message: "normalizeMessageToolCalls called",
      data: {
        hasMessage: !!message,
        messageType: typeof message,
        hasAdditionalKwargs: !!message?.additional_kwargs,
        hasToolCalls: Array.isArray(message?.tool_calls),
        hasFunctionCall: !!message?.function_call,
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "A,C",
    }),
  }).catch(() => {});
  // #endregion

  if (!message || typeof message !== "object") return message;

  const normalized = { ...message };
  const additionalKwargs = normalized.additional_kwargs;
  if (additionalKwargs && typeof additionalKwargs === "object") {
    const kwargs = { ...additionalKwargs };
    if (kwargs.function_call && typeof kwargs.function_call === "object") {
      const functionCall = { ...kwargs.function_call };
      if ("arguments" in functionCall) {
        functionCall.arguments = normalizeToolArguments(functionCall.arguments);
      }
      kwargs.function_call = functionCall;
    }
    if (Array.isArray(kwargs.tool_calls)) {
      kwargs.tool_calls = kwargs.tool_calls.map((call: any) => {
        if (!call || typeof call !== "object") return call;
        const normalizedCall = { ...call };
        if (
          normalizedCall.function &&
          typeof normalizedCall.function === "object"
        ) {
          const fn = { ...normalizedCall.function };
          if ("arguments" in fn) {
            fn.arguments = normalizeToolArguments(fn.arguments);
          }
          normalizedCall.function = fn;
        }
        return normalizedCall;
      });
    }
    normalized.additional_kwargs = kwargs;
  }

  if (Array.isArray(normalized.tool_calls)) {
    normalized.tool_calls = normalized.tool_calls.map((call: any) => {
      if (!call || typeof call !== "object") return call;
      const normalizedCall = { ...call };
      if (
        normalizedCall.function &&
        typeof normalizedCall.function === "object"
      ) {
        const fn = { ...normalizedCall.function };
        if ("arguments" in fn) {
          // #region agent log
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:normalizeMessageToolCalls:toolCallArgs",
                message: "Normalizing tool_call function.arguments",
                data: {
                  argsType: typeof fn.arguments,
                  argsPreview:
                    typeof fn.arguments === "string"
                      ? fn.arguments.substring(0, 200)
                      : String(fn.arguments).substring(0, 200),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A,C",
              }),
            },
          ).catch(() => {});
          // #endregion
          fn.arguments = normalizeToolArguments(fn.arguments);
        }
        normalizedCall.function = fn;
      }
      return normalizedCall;
    });
  }

  if (
    normalized.function_call &&
    typeof normalized.function_call === "object"
  ) {
    const functionCall = { ...normalized.function_call };
    if ("arguments" in functionCall) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "index.ts:normalizeMessageToolCalls:functionCallArgs",
            message: "Normalizing function_call.arguments",
            data: {
              argsType: typeof functionCall.arguments,
              argsPreview:
                typeof functionCall.arguments === "string"
                  ? functionCall.arguments.substring(0, 200)
                  : String(functionCall.arguments).substring(0, 200),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "A,C",
          }),
        },
      ).catch(() => {});
      // #endregion
      functionCall.arguments = normalizeToolArguments(functionCall.arguments);
    }
    normalized.function_call = functionCall;
  }

  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "index.ts:normalizeMessageToolCalls:exit",
      message: "normalizeMessageToolCalls returning",
      data: {
        normalizedPreview: JSON.stringify(normalized).substring(0, 500),
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "C",
    }),
  }).catch(() => {});
  // #endregion

  return normalized;
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

  // PHASE 5: Langfuse parity - explicit trace-level I/O (updateTrace)
  private traceLevelInput: string | null = null;
  private traceLevelOutput: string | null = null;

  // Track traces with errors (for automatic trace_end generation when using instrumentation)
  private tracesWithErrors: Set<string> = new Set();
  // Track root span IDs for traces (for automatic trace_end generation)
  private traceRootSpanIds: Map<string, string> = new Map();
  // Track known span IDs per trace to validate feedback parentSpanId
  private traceSpanIds: Map<string, Set<string>> = new Map();

  private registerSpanForTrace(
    traceId: string | null | undefined,
    spanId: string,
  ): void {
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
            "or explicitly provide tenantId and projectId in the config.",
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
          "This should never happen - please report this error.",
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
      })`,
    );

    // Debug logging
    if (!this.isProduction) {
      console.log(`🔗 [Observa] API URL: ${this.apiUrl}`);
      console.log(`🔗 [Observa] Tenant: ${this.tenantId}`);
      console.log(`🔗 [Observa] Project: ${this.projectId}`);
      console.log(
        `🔗 [Observa] Auth: ${
          jwtContext ? "JWT (auto-extracted)" : "Legacy (config)"
        }`,
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
    },
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

    const resolvedParentSpanId =
      (eventData.parent_span_id !== undefined
        ? eventData.parent_span_id
        : parentSpanId) ?? null;

    const event: CanonicalEvent = {
      ...baseProps,
      trace_id: (eventData as any).trace_id ?? baseProps.trace_id,
      span_id: spanId,
      parent_span_id:
        resolvedParentSpanId === spanId ? null : resolvedParentSpanId,
      timestamp: eventData.timestamp || new Date().toISOString(),
      event_type: eventData.event_type,
      conversation_id: eventData.conversation_id ?? null,
      session_id: eventData.session_id ?? null,
      user_id: eventData.user_id ?? null,
      agent_name: eventData.agent_name ?? null,
      version: eventData.version ?? null,
      route: eventData.route ?? null,
      attributes: (() => {
        // #region agent log
        const attrsStr = JSON.stringify(eventData.attributes);
        fetch(
          "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "index.ts:addEvent:beforeSanitize",
              message: "Attributes before sanitizeAttributesForStorage",
              data: {
                attributesPreview: attrsStr.substring(0, 500),
                attributesLength: attrsStr.length,
                hasInputMessages:
                  !!eventData.attributes?.llm_call?.input_messages,
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "C,D,E",
            }),
          },
        ).catch(() => {});
        // #endregion
        const sanitized = sanitizeAttributesForStorage(
          eventData.attributes,
          undefined,
          this.maxResponseChars,
        );
        // #region agent log
        try {
          const sanitizedStr = JSON.stringify(sanitized);
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:addEvent:afterSanitize",
                message: "Attributes after sanitizeAttributesForStorage",
                data: {
                  sanitizedPreview: sanitizedStr.substring(0, 500),
                  sanitizedLength: sanitizedStr.length,
                  isValidJSON: true,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "C,D,E",
              }),
            },
          ).catch(() => {});
        } catch (e) {
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:addEvent:afterSanitize",
                message: "ERROR: sanitized attributes are invalid JSON",
                data: { error: String(e) },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "E",
              }),
            },
          ).catch(() => {});
        }
        // #endregion
        return sanitized;
      })(),
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
        },
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
      // CRITICAL: Support for LangChain handler to pass chain data
      chainType?: string;
      numPrompts?: number;
      attributes?: Record<string, any>;
      attributes_json?: string;
    } = {},
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
    this.traceLevelInput = null;
    this.traceLevelOutput = null;
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
          hasChainType: !!options.chainType,
          hasNumPrompts: options.numPrompts !== undefined,
          hasAttributesJson: !!options.attributes_json,
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "J",
      }),
    }).catch(() => {});
    // #endregion

    // CRITICAL: Build trace_start attributes with chain data if provided
    // If attributes_json is provided, parse it and merge with other data
    // Otherwise, build from individual parameters
    let traceStartAttributes: any = {
      name: options.name || null,
      metadata: options.metadata || null,
    };

    // If attributes_json is provided, parse it and use it (preferred)
    if (options.attributes_json) {
      try {
        const parsed = JSON.parse(options.attributes_json);
        if (parsed && typeof parsed === "object" && parsed.trace_start) {
          traceStartAttributes = {
            ...traceStartAttributes,
            ...parsed.trace_start, // Merge parsed data
          };
        }
      } catch (error) {
        console.warn(
          "[Observa] Failed to parse attributes_json in startTrace, using individual parameters:",
          error,
        );
        // Fall through to use individual parameters
      }
    }

    // If attributes object is provided, extract trace_start from it
    if (options.attributes && typeof options.attributes === "object") {
      if (options.attributes.trace_start) {
        traceStartAttributes = {
          ...traceStartAttributes,
          ...options.attributes.trace_start,
        };
      }
    }

    // Add chain-specific data if provided (merge with parsed data)
    if (options.chainType) {
      traceStartAttributes.chain_type = options.chainType;
    }
    if (options.numPrompts !== undefined && options.numPrompts !== null) {
      traceStartAttributes.num_prompts = options.numPrompts;
    }
    if (!traceStartAttributes.created_at) {
      traceStartAttributes.created_at = new Date().toISOString();
    }

    this.addEvent({
      event_type: "trace_start",
      span_id: this.rootSpanId,
      parent_span_id: null,
      conversation_id: options.conversationId || null,
      session_id: options.sessionId || null,
      user_id: options.userId || null,
      attributes: {
        trace_start: traceStartAttributes,
      },
    });

    return this.currentTraceId;
  }

  /**
   * Track trace_start event directly (for LangChain handler compatibility)
   * This method allows the LangChain handler to send trace_start events with chain data
   */
  trackTraceStart(payload: {
    spanId: string;
    parentSpanId: string | null;
    traceId: string | null;
    attributes?: Record<string, any>;
    attributes_json?: string;
  }): void {
    // If no trace is active, create one
    if (!this.currentTraceId && payload.traceId) {
      this.currentTraceId = payload.traceId;
      this.rootSpanId = payload.spanId;
      this.spanStack = [this.rootSpanId];
      this.traceStartTime = Date.now();
    }

    // Parse attributes_json if provided
    let traceStartAttributes: any = {};
    if (payload.attributes_json) {
      try {
        const parsed = JSON.parse(payload.attributes_json);
        if (parsed && typeof parsed === "object" && parsed.trace_start) {
          traceStartAttributes = parsed.trace_start;
        } else if (parsed && typeof parsed === "object") {
          traceStartAttributes = parsed;
        }
      } catch (error) {
        console.warn(
          "[Observa] Failed to parse attributes_json in trackTraceStart:",
          error,
        );
      }
    }

    // Merge with attributes object if provided
    if (payload.attributes && typeof payload.attributes === "object") {
      if (payload.attributes.trace_start) {
        traceStartAttributes = {
          ...traceStartAttributes,
          ...payload.attributes.trace_start,
        };
      } else {
        traceStartAttributes = {
          ...traceStartAttributes,
          ...payload.attributes,
        };
      }
    }

    // Ensure we have at least some data
    if (Object.keys(traceStartAttributes).length === 0) {
      traceStartAttributes = {
        created_at: new Date().toISOString(),
      };
    } else if (!traceStartAttributes.created_at) {
      traceStartAttributes.created_at = new Date().toISOString();
    }

    this.addEvent({
      event_type: "trace_start",
      span_id: payload.spanId,
      parent_span_id: payload.parentSpanId,
      trace_id: payload.traceId || this.currentTraceId || crypto.randomUUID(),
      attributes: {
        trace_start: traceStartAttributes,
      },
    });
  }

  /**
   * Send a canonical event directly (for LangChain handler compatibility)
   * This allows the handler to send events that aren't covered by specific track methods
   */
  sendEvent(event: {
    event_type: string;
    span_id: string;
    parent_span_id: string | null;
    trace_id: string | null;
    attributes?: Record<string, any>;
    attributes_json?: string;
    timestamp?: string;
  }): void {
    // Parse attributes_json if provided
    let attributes: any = event.attributes || {};
    if (event.attributes_json) {
      try {
        const parsed = JSON.parse(event.attributes_json);
        if (parsed && typeof parsed === "object") {
          attributes = parsed;
        }
      } catch (error) {
        console.warn(
          "[Observa] Failed to parse attributes_json in sendEvent:",
          error,
        );
      }
    }

    this.addEvent({
      event_type: event.event_type as any,
      span_id: event.span_id,
      parent_span_id: event.parent_span_id,
      trace_id: event.trace_id || this.currentTraceId || crypto.randomUUID(),
      timestamp: event.timestamp || new Date().toISOString(),
      attributes,
    });
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
   * PHASE 5: Langfuse parity - Set trace-level input/output explicitly.
   * Values are included in trace_end on endTrace and used by the API for summary.query/response.
   */
  updateTrace(input?: string | null, output?: string | null): void {
    if (input !== undefined) this.traceLevelInput = input;
    if (output !== undefined) this.traceLevelOutput = output;
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
    toolDefinitions?: Array<Record<string, any>> | null;
    tools?: Array<Record<string, any>> | null;
    // PHASE 5: Langfuse parity - when true, omit output (caller uses trackOutput for final answer)
    isFinalOutput?: boolean;
    // PHASE 5: Langfuse parity - observation type (span, generation, tool, agent, chain, etc.)
    observationType?:
      | "span"
      | "generation"
      | "tool"
      | "agent"
      | "chain"
      | "retriever"
      | "embedding"
      | "evaluator"
      | "guardrail"
      | null;
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

    // Normalize tool call arguments so we avoid double-encoded JSON strings
    const normalizedInputMessages = options.inputMessages
      ? options.inputMessages.map((message) =>
          normalizeMessageToolCalls(message),
        )
      : null;
    const normalizedOutputMessages = options.outputMessages
      ? options.outputMessages.map((message) =>
          normalizeMessageToolCalls(message),
        )
      : null;
    const safeInputMessages = normalizedInputMessages
      ? toPlainJson(normalizedInputMessages, this.maxResponseChars)
      : null;
    const safeOutputMessages = normalizedOutputMessages
      ? toPlainJson(normalizedOutputMessages, this.maxResponseChars)
      : null;

    // CRITICAL FIX: Mark span as error if output is null (empty response)
    const isError =
      options.output === null ||
      (typeof options.output === "string" &&
        options.output.trim().length === 0) ||
      options.finishReason === "content_filter" ||
      options.finishReason === "length" ||
      options.finishReason === "max_tokens";

    const safeMetadata = options.metadata
      ? toPlainJson(options.metadata, this.maxResponseChars)
      : null;

    // PHASE 5: When isFinalOutput=true, omit output (caller uses trackOutput for final answer)
    const llmOutput =
      options.isFinalOutput === true ? null : (options.output ?? null);

    this.addEvent({
      ...(options.traceId ? { trace_id: options.traceId } : {}),
      event_type: "llm_call",
      span_id: spanId,
      attributes: {
        llm_call: {
          model: options.model,
          input: options.input || null,
          output: llmOutput,
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
          input_messages: safeInputMessages || null,
          output_messages: safeOutputMessages || null,
          system_instructions: options.systemInstructions || null,
          // TIER 2: Server metadata
          server_address: options.serverAddress || null,
          server_port: options.serverPort || null,
          // TIER 2: Conversation grouping
          conversation_id_otel: options.conversationIdOtel || null,
          choice_count: options.choiceCount || null,
          tool_definitions: options.toolDefinitions ?? options.tools ?? null,
          tools: options.tools ?? options.toolDefinitions ?? null,
          // CRITICAL: Status field to mark errors (backend will use this to set span status)
          status: isError ? "error" : "success",
        },
        // Add metadata at top level of attributes (matching Langfuse format)
        ...(safeMetadata ? { metadata: safeMetadata } : {}),
        // PHASE 5: Langfuse parity - observation type for UI categorization
        ...(options.observationType
          ? { observation_type: options.observationType }
          : {}),
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
    // PHASE 5: Langfuse parity - observation type
    observationType?:
      | "span"
      | "generation"
      | "tool"
      | "agent"
      | "chain"
      | "retriever"
      | "embedding"
      | "evaluator"
      | "guardrail"
      | null;
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
        ...(options.observationType
          ? { observation_type: options.observationType }
          : {}),
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
          },
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
    } = {},
  ): Promise<string> {
    if (!this.currentTraceId || !this.rootSpanId) {
      throw new Error("[Observa] No active trace. Call startTrace() first.");
    }

    // Calculate summary statistics from buffered events for this trace
    const traceEvents = this.eventBuffer.filter(
      (e) => e.trace_id === this.currentTraceId,
    );
    const llmEvents = traceEvents.filter((e) => e.event_type === "llm_call");
    const totalTokens = llmEvents.reduce(
      (sum, e) => sum + (e.attributes.llm_call?.total_tokens || 0),
      0,
    );
    const totalCost = llmEvents.reduce(
      (sum, e) => sum + (e.attributes.llm_call?.cost || 0),
      0,
    );

    // Calculate total latency
    const totalLatency =
      this.traceStartTime !== null ? Date.now() - this.traceStartTime : null;

    // Add trace_end event (PHASE 5: include trace_level_input/output when set via updateTrace)
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
          trace_level_input: this.traceLevelInput,
          trace_level_output: this.traceLevelOutput,
        },
      },
    });

    // Get all events for this trace
    const traceEventsToSend = this.eventBuffer.filter(
      (e) => e.trace_id === this.currentTraceId,
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
        (e) => e.trace_id !== this.currentTraceId,
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
          0,
        );
        const totalCost = llmEvents.reduce(
          (sum, e) => sum + (e.attributes.llm_call?.cost || 0),
          0,
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
    maxRetries: number = 3,
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
            error,
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
    },
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
    },
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
   * Observe LangChain - returns a callback handler for LangChain
   *
   * @param options - Observation options (name, tags, userId, sessionId, redact)
   * @returns LangChain callback handler for tracing
   *
   * @example
   * ```typescript
   * import { init } from 'observa-sdk';
   * const observa = init({ apiKey: '...' });
   * const handler = observa.observeLangChain({ name: 'my-app' });
   * ```
   */
  observeLangChain(options?: {
    name?: string;
    tags?: string[];
    userId?: string;
    sessionId?: string;
    redact?: (data: any) => any;
  }): any {
    try {
      return observeLangChainFn(this, { ...options, observa: this });
    } catch (error) {
      console.error("[Observa] Failed to load LangChain handler:", error);
      return {
        handleChainStart: () => Promise.resolve(),
        handleChainEnd: () => Promise.resolve(),
        handleChainError: () => Promise.resolve(),
        handleLLMStart: () => Promise.resolve(),
        handleLLMNewToken: () => Promise.resolve(),
        handleLLMEnd: () => Promise.resolve(),
        handleLLMError: () => Promise.resolve(),
        handleToolStart: () => Promise.resolve(),
        handleToolEnd: () => Promise.resolve(),
        handleToolError: () => Promise.resolve(),
        handleRetrieverStart: () => Promise.resolve(),
        handleRetrieverEnd: () => Promise.resolve(),
        handleRetrieverError: () => Promise.resolve(),
        handleAgentAction: () => Promise.resolve(),
        handleAgentFinish: () => Promise.resolve(),
      };
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
    },
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
        },
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
        }`,
      );

      // Add timeout to prevent hanging requests (10 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        // #region agent log
        // Check for problematic arguments in events before serialization
        for (const evt of events) {
          if (evt.event_type === "llm_call") {
            const inputMessages = (evt.attributes as any)?.llm_call
              ?.input_messages;
            const outputMessages = (evt.attributes as any)?.llm_call
              ?.output_messages;
            if (Array.isArray(inputMessages)) {
              for (const msg of inputMessages) {
                if (msg?.additional_kwargs?.function_call?.arguments) {
                  const args = msg.additional_kwargs.function_call.arguments;
                  fetch(
                    "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        location: "index.ts:sendEvents:preSerialize",
                        message:
                          "Found function_call.arguments in input_messages",
                        data: {
                          argsType: typeof args,
                          argsPreview:
                            typeof args === "string"
                              ? args.substring(0, 200)
                              : JSON.stringify(args).substring(0, 200),
                        },
                        timestamp: Date.now(),
                        sessionId: "debug-session",
                        runId: "run1",
                        hypothesisId: "D,E",
                      }),
                    },
                  ).catch(() => {});
                }
                if (Array.isArray(msg?.additional_kwargs?.tool_calls)) {
                  for (const tc of msg.additional_kwargs.tool_calls) {
                    if (tc?.function?.arguments) {
                      const args = tc.function.arguments;
                      fetch(
                        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            location: "index.ts:sendEvents:preSerialize",
                            message:
                              "Found tool_call function.arguments in input_messages",
                            data: {
                              argsType: typeof args,
                              argsPreview:
                                typeof args === "string"
                                  ? args.substring(0, 200)
                                  : JSON.stringify(args).substring(0, 200),
                            },
                            timestamp: Date.now(),
                            sessionId: "debug-session",
                            runId: "run1",
                            hypothesisId: "D,E",
                          }),
                        },
                      ).catch(() => {});
                    }
                  }
                }
              }
            }
            if (Array.isArray(outputMessages)) {
              for (const msg of outputMessages) {
                if (msg?.additional_kwargs?.function_call?.arguments) {
                  const args = msg.additional_kwargs.function_call.arguments;
                  fetch(
                    "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        location: "index.ts:sendEvents:preSerialize",
                        message:
                          "Found function_call.arguments in output_messages",
                        data: {
                          argsType: typeof args,
                          argsPreview:
                            typeof args === "string"
                              ? args.substring(0, 200)
                              : JSON.stringify(args).substring(0, 200),
                        },
                        timestamp: Date.now(),
                        sessionId: "debug-session",
                        runId: "run1",
                        hypothesisId: "D,E",
                      }),
                    },
                  ).catch(() => {});
                }
                if (Array.isArray(msg?.additional_kwargs?.tool_calls)) {
                  for (const tc of msg.additional_kwargs.tool_calls) {
                    if (tc?.function?.arguments) {
                      const args = tc.function.arguments;
                      fetch(
                        "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            location: "index.ts:sendEvents:preSerialize",
                            message:
                              "Found tool_call function.arguments in output_messages",
                            data: {
                              argsType: typeof args,
                              argsPreview:
                                typeof args === "string"
                                  ? args.substring(0, 200)
                                  : JSON.stringify(args).substring(0, 200),
                            },
                            timestamp: Date.now(),
                            sessionId: "debug-session",
                            runId: "run1",
                            hypothesisId: "D,E",
                          }),
                        },
                      ).catch(() => {});
                    }
                  }
                }
              }
            }
          }
        }
        // #endregion

        // Final pass: recursively fix any remaining malformed argument strings
        // This catches any cases that might have bypassed earlier normalization
        const fixMalformedArguments = (obj: any): any => {
          if (obj === null || obj === undefined) return obj;
          if (typeof obj === "string") {
            // Check if this string looks like malformed JSON arguments
            const trimmed = obj.trim();
            if (
              trimmed.startsWith('"') &&
              !trimmed.startsWith('"{') &&
              trimmed.includes(":") &&
              trimmed.length > 3
            ) {
              // #region agent log
              fetch(
                "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    location: "index.ts:fixMalformedArguments:stringFound",
                    message: "Found potential malformed string in final pass",
                    data: {
                      stringValue: trimmed.substring(0, 200),
                      stringLength: trimmed.length,
                    },
                    timestamp: Date.now(),
                    sessionId: "debug-session",
                    runId: "run1",
                    hypothesisId: "F",
                  }),
                },
              ).catch(() => {});
              // #endregion

              try {
                const normalized = normalizeToolArguments(obj);
                if (typeof normalized !== "string") {
                  // #region agent log
                  fetch(
                    "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        location: "index.ts:fixMalformedArguments:fixed",
                        message:
                          "Successfully fixed malformed string in final pass",
                        data: {
                          original: trimmed.substring(0, 100),
                          normalized: JSON.stringify(normalized).substring(
                            0,
                            100,
                          ),
                        },
                        timestamp: Date.now(),
                        sessionId: "debug-session",
                        runId: "run1",
                        hypothesisId: "F",
                      }),
                    },
                  ).catch(() => {});
                  // #endregion
                  return normalized;
                } else {
                  // #region agent log
                  fetch(
                    "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        location: "index.ts:fixMalformedArguments:stillString",
                        message:
                          "WARNING: Normalization returned string - this may cause error",
                        data: {
                          stringValue: trimmed.substring(0, 200),
                          normalizedValue: normalized.substring(0, 200),
                        },
                        timestamp: Date.now(),
                        sessionId: "debug-session",
                        runId: "run1",
                        hypothesisId: "F",
                      }),
                    },
                  ).catch(() => {});
                  // #endregion
                }
              } catch (e) {
                // #region agent log
                fetch(
                  "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      location:
                        "index.ts:fixMalformedArguments:normalizeFailed",
                      message: "ERROR: Normalization failed in final pass",
                      data: {
                        error: String(e),
                        stringValue: trimmed.substring(0, 200),
                      },
                      timestamp: Date.now(),
                      sessionId: "debug-session",
                      runId: "run1",
                      hypothesisId: "F",
                    }),
                  },
                ).catch(() => {});
                // #endregion
              }
            }
            return obj;
          }
          if (Array.isArray(obj)) {
            return obj.map(fixMalformedArguments);
          }
          if (typeof obj === "object") {
            const fixed: Record<string, any> = {};
            for (const [key, val] of Object.entries(obj)) {
              // Special handling for arguments fields
              if (key === "arguments" && typeof val === "string") {
                fixed[key] = fixMalformedArguments(val);
              } else if (
                key === "function_call" &&
                val &&
                typeof val === "object"
              ) {
                const fixedVal = { ...val } as Record<string, any>;
                if (
                  "arguments" in fixedVal &&
                  typeof fixedVal.arguments === "string"
                ) {
                  fixedVal.arguments = fixMalformedArguments(
                    fixedVal.arguments,
                  );
                }
                fixed[key] = fixMalformedArguments(fixedVal);
              } else if (key === "function" && val && typeof val === "object") {
                const fixedVal = { ...val } as Record<string, any>;
                if (
                  "arguments" in fixedVal &&
                  typeof fixedVal.arguments === "string"
                ) {
                  fixedVal.arguments = fixMalformedArguments(
                    fixedVal.arguments,
                  );
                }
                fixed[key] = fixMalformedArguments(fixedVal);
              } else {
                fixed[key] = fixMalformedArguments(val);
              }
            }
            return fixed;
          }
          return obj;
        };

        const fixedEvents = events.map(fixMalformedArguments);

        const payload = safeJsonStringify(fixedEvents, {
          maxStringLength: this.maxResponseChars,
        });

        // #region agent log
        // Validate the payload is valid JSON and check for problematic patterns
        try {
          const parsed = JSON.parse(payload); // Validate it's parseable

          // Deep check: recursively search for any arguments fields that are strings
          const checkForStringArguments = (
            obj: any,
            path: string = "",
          ): void => {
            if (obj === null || obj === undefined) return;
            if (typeof obj === "string") {
              const trimmed = obj.trim();
              if (
                trimmed.startsWith('"') &&
                !trimmed.startsWith('"{') &&
                trimmed.includes(":") &&
                trimmed.length > 3
              ) {
                fetch(
                  "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      location: "index.ts:sendEvents:deepCheckFound",
                      message:
                        "CRITICAL: Found malformed string in parsed payload",
                      data: {
                        path,
                        stringValue: trimmed.substring(0, 200),
                        stringLength: trimmed.length,
                      },
                      timestamp: Date.now(),
                      sessionId: "debug-session",
                      runId: "run1",
                      hypothesisId: "E",
                    }),
                  },
                ).catch(() => {});
              }
              return;
            }
            if (Array.isArray(obj)) {
              obj.forEach((item, idx) =>
                checkForStringArguments(item, `${path}[${idx}]`),
              );
              return;
            }
            if (typeof obj === "object") {
              for (const [key, val] of Object.entries(obj)) {
                const newPath = path ? `${path}.${key}` : key;
                if (key === "arguments" && typeof val === "string") {
                  fetch(
                    "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        location: "index.ts:sendEvents:deepCheckArguments",
                        message:
                          "CRITICAL: Found string arguments field in parsed payload",
                        data: {
                          path: newPath,
                          stringValue: (val as string).substring(0, 200),
                          stringLength: (val as string).length,
                        },
                        timestamp: Date.now(),
                        sessionId: "debug-session",
                        runId: "run1",
                        hypothesisId: "E",
                      }),
                    },
                  ).catch(() => {});
                }
                checkForStringArguments(val, newPath);
              }
            }
          };
          checkForStringArguments(parsed);

          // Check for the problematic pattern in the serialized string
          const problematicPattern = /"arguments":""[^"]+":/;
          if (problematicPattern.test(payload)) {
            const match = payload.match(problematicPattern);
            const contextStart = Math.max(0, (match?.index || 0) - 100);
            const contextEnd = Math.min(
              payload.length,
              (match?.index || 0) + 300,
            );
            fetch(
              "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "index.ts:sendEvents:postSerialize",
                  message:
                    "ERROR: Found problematic arguments pattern in serialized payload",
                  data: {
                    context: payload.substring(contextStart, contextEnd),
                    payloadLength: payload.length,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "E",
                }),
              },
            ).catch(() => {});
          } else {
            fetch(
              "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "index.ts:sendEvents:postSerialize",
                  message:
                    "Payload serialized successfully, no problematic pattern found",
                  data: { payloadLength: payload.length },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "E",
                }),
              },
            ).catch(() => {});
          }
        } catch (e) {
          fetch(
            "http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "index.ts:sendEvents:postSerialize",
                message: "ERROR: Payload is not valid JSON",
                data: {
                  error: String(e),
                  payloadPreview: payload.substring(0, 500),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "E",
              }),
            },
          ).catch(() => {});
        }
        // #endregion

        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: payload,
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
          },
        ).catch(() => {});
        // #endregion

        // Always log response status for debugging
        console.log(
          `[Observa] Response status: ${response.status} ${response.statusText}`,
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
            },
          ).catch(() => {});
          // #endregion

          console.error(
            `[Observa] Backend API error: ${response.status} ${response.statusText}`,
            errorJson.error || errorText,
          );
          throw new Error(
            `Observa API error: ${response.status} ${
              errorJson.error?.message || errorText
            }`,
          );
        } else {
          const result = await response.json().catch(() => ({}));
          // Log success even in production for debugging
          console.log(
            `✅ [Observa] Events sent successfully - Trace ID: ${traceId}, Event count: ${
              result.event_count || events.length
            }`,
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
            "[Observa] Request timed out - check network connectivity and API URL",
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
