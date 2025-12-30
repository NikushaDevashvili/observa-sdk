/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------
// Observa SDK (Speed MVP)
// - Captures streaming AI responses (ReadableStream.tee)
// - Logs beautifully in dev mode
// - Sends events to Tinybird Events API in NDJSON
// ------------------------------------------------------------

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

export interface TrackEventInput {
  query: string;
  context?: string;
  model?: string;
  metadata?: Record<string, any>;
  // Conversation tracking fields
  conversationId?: string;  // Long-lived conversation identifier
  sessionId?: string;       // Short-lived session identifier
  userId?: string;          // End-user identifier
  messageIndex?: number;    // Position in conversation (1, 2, 3...)
  parentMessageId?: string;  // For threaded conversations
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

// ---------- SSE helpers (for OpenAI-style streamed chunks) ----------
function parseSSEChunk(chunk: string): any {
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") return { done: true };
    try {
      return JSON.parse(payload);
    } catch {
      // ignore
    }
  }
  return {};
}

function extractMetadataFromChunks(chunks: string[]): {
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;
  model?: string | null;
  finishReason?: string | null;
  responseId?: string | null;
  systemFingerprint?: string | null;
} {
  let tokensPrompt: number | null | undefined;
  let tokensCompletion: number | null | undefined;
  let tokensTotal: number | null | undefined;
  let model: string | null | undefined;
  let finishReason: string | null | undefined;
  let responseId: string | null | undefined;
  let systemFingerprint: string | null | undefined;

  for (const chunk of chunks) {
    const parsed = parseSSEChunk(chunk);
    if (parsed?.usage) {
      tokensPrompt = parsed.usage.prompt_tokens ?? tokensPrompt;
      tokensCompletion = parsed.usage.completion_tokens ?? tokensCompletion;
      tokensTotal = parsed.usage.total_tokens ?? tokensTotal;
    }
    if (parsed?.model && !model) model = parsed.model;
    if (parsed?.id && !responseId) responseId = parsed.id;
    if (parsed?.system_fingerprint && !systemFingerprint)
      systemFingerprint = parsed.system_fingerprint;

    // finish_reason usually appears inside choices
    const fr = parsed?.choices?.[0]?.finish_reason;
    if (fr && !finishReason) finishReason = fr;
  }

  return {
    tokensPrompt: tokensPrompt ?? null,
    tokensCompletion: tokensCompletion ?? null,
    tokensTotal: tokensTotal ?? null,
    model: model ?? null,
    finishReason: finishReason ?? null,
    responseId: responseId ?? null,
    systemFingerprint: systemFingerprint ?? null,
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

  private tenantId: string;
  private projectId: string;
  private environment: "dev" | "prod";

  private apiUrl: string;

  private isProduction: boolean;
  private sampleRate: number;
  private maxResponseChars: number;

  constructor(config: ObservaInitConfig) {
    this.apiKey = config.apiKey;

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
  }

  async track(event: TrackEventInput, action: () => Promise<Response>) {
    // sampling (cheap control knob)
    if (this.sampleRate < 1 && Math.random() > this.sampleRate) {
      return action();
    }

    const startTime = Date.now();
    const traceId = crypto.randomUUID();
    const spanId = traceId; // MVP: 1 span per trace

    const originalResponse = await action();
    if (!originalResponse.body) return originalResponse;

    // capture response headers
    const responseHeaders: Record<string, string> = {};
    originalResponse.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const [stream1, stream2] = originalResponse.body.tee();

    // don't await => never block user, but log to track execution
    console.log(`[Observa] Starting captureStream for trace ${traceId}`);
    this.captureStream({
      stream: stream2,
      event,
      traceId,
      spanId,
      parentSpanId: null,
      startTime,
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: responseHeaders,
    }).catch((err) => {
      console.error("[Observa] captureStream promise rejected:", err);
    });

    return new Response(stream1, {
      headers: originalResponse.headers,
      status: originalResponse.status,
      statusText: originalResponse.statusText,
    });
  }

  private async captureStream(args: {
    stream: ReadableStream;
    event: TrackEventInput;
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    startTime: number;
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  }) {
    const {
      stream,
      event,
      traceId,
      spanId,
      parentSpanId,
      startTime,
      status,
      statusText,
      headers,
    } = args;

    console.log(`[Observa] captureStream started for trace ${traceId}`);
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      let fullResponse = "";
      let firstTokenTime: number | undefined;
      const chunks: string[] = [];
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!firstTokenTime && value && value.length > 0) {
          firstTokenTime = Date.now();
        }

        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
        buffer += chunk;

        // parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed?.choices?.[0]?.delta?.content) {
              fullResponse += parsed.choices[0].delta.content;
            } else if (parsed?.choices?.[0]?.text) {
              fullResponse += parsed.choices[0].text;
            } else if (typeof parsed?.content === "string") {
              fullResponse += parsed.content;
            }
          } catch {
            // non-json payload; keep as text
            fullResponse += data;
          }
        }

        // hard safety cap (avoid huge payload / cost)
        if (fullResponse.length > this.maxResponseChars) {
          fullResponse =
            fullResponse.slice(0, this.maxResponseChars) + "…[TRUNCATED]";
          break;
        }
      }

      if (buffer.trim()) {
        // leftover
        fullResponse += buffer;
      }

      const endTime = Date.now();
      const latencyMs = endTime - startTime;

      const timeToFirstTokenMs =
        firstTokenTime != null ? firstTokenTime - startTime : null;
      const streamingDurationMs =
        firstTokenTime != null ? endTime - firstTokenTime : null;

      const extracted = extractMetadataFromChunks(chunks);

      // Validate tenant context is set (should never fail due to constructor validation, but safety check)
      if (!this.tenantId || !this.projectId) {
        throw new Error(
          "Observa SDK: tenantId and projectId must be set. This indicates a SDK configuration error."
        );
      }

      const traceData: TraceData = {
        traceId,
        spanId,
        parentSpanId,

        timestamp: new Date().toISOString(),

        tenantId: this.tenantId,
        projectId: this.projectId,
        environment: this.environment,

        query: event.query,
        ...(event.context !== undefined && { context: event.context }),
        ...((extracted.model ?? event.model) !== undefined && {
          model: extracted.model ?? event.model,
        }),
        ...(event.metadata !== undefined && { metadata: event.metadata }),

        response: fullResponse,
        responseLength: fullResponse.length,

        tokensPrompt: extracted.tokensPrompt ?? null,
        tokensCompletion: extracted.tokensCompletion ?? null,
        tokensTotal: extracted.tokensTotal ?? null,

        latencyMs,
        timeToFirstTokenMs,
        streamingDurationMs,

        status: status ?? null,
        statusText: statusText ?? null,

        finishReason: extracted.finishReason ?? null,
        responseId: extracted.responseId ?? null,
        systemFingerprint: extracted.systemFingerprint ?? null,

        ...(headers !== undefined && { headers }),

        // Conversation tracking fields
        ...(event.conversationId !== undefined && { conversationId: event.conversationId }),
        ...(event.sessionId !== undefined && { sessionId: event.sessionId }),
        ...(event.userId !== undefined && { userId: event.userId }),
        ...(event.messageIndex !== undefined && { messageIndex: event.messageIndex }),
        ...(event.parentMessageId !== undefined && { parentMessageId: event.parentMessageId }),
      };

      console.log(
        `[Observa] Trace data prepared, calling sendTrace for ${traceId}, response length: ${fullResponse.length}`
      );
      await this.sendTrace(traceData);
      console.log(`[Observa] sendTrace completed for ${traceId}`);
    } catch (err) {
      console.error("[Observa] Error capturing stream:", err);
      if (err instanceof Error) {
        console.error("[Observa] Error name:", err.name);
        console.error("[Observa] Error message:", err.message);
        if (err.stack) {
          console.error("[Observa] Error stack:", err.stack);
        }
      }
    }
  }

  private async sendTrace(trace: TraceData) {
    // Dev mode: show pretty logs for debugging
    if (!this.isProduction) {
      formatBeautifulLog(trace);
    }

    // Send to Observa backend (which forwards to Tinybird)
    try {
      // Remove trailing slash from apiUrl if present, then add the path
      const baseUrl = this.apiUrl.replace(/\/+$/, "");
      const url = `${baseUrl}/api/v1/traces/ingest`;

      // Enhanced logging for debugging (always log in production too)
      // Single combined log to avoid Vercel truncation
      console.log(
        `[Observa] Sending trace - URL: ${url}, TraceID: ${
          trace.traceId
        }, Tenant: ${trace.tenantId}, Project: ${trace.projectId}, APIKey: ${
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
          body: JSON.stringify(trace),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

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

          console.error(
            `[Observa] Backend API error: ${response.status} ${response.statusText}`,
            errorJson.error || errorText
          );
        } else {
          // Log success even in production for debugging
          console.log(
            `✅ [Observa] Trace sent successfully - Trace ID: ${trace.traceId}`
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
      console.error("[Observa] Failed to send trace:", error);
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
    }
  }
}

// factory
export const init = (config: ObservaInitConfig) => new Observa(config);
