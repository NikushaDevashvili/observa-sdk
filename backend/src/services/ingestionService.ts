import { TraceEvent, TinybirdEvent } from "../types.js";
import { TokenService } from "./tokenService.js";
import { TenantService } from "./tenantService.js";

const TINYBIRD_HOST = process.env.TINYBIRD_HOST || "https://api.europe-west2.gcp.tinybird.co";
const TINYBIRD_DATASOURCE_NAME =
  process.env.TINYBIRD_DATASOURCE_NAME || "traces";

/**
 * Ingestion Service
 * Validates JWT tokens and forwards trace data to Tinybird
 */
export class IngestionService {
  /**
   * Convert TraceEvent to Tinybird event format
   */
  private static toTinybirdEvent(trace: TraceEvent): TinybirdEvent {
    return {
      tenant_id: trace.tenantId,
      project_id: trace.projectId,
      environment: trace.environment,
      trace_id: trace.traceId,
      span_id: trace.spanId,
      parent_span_id: trace.parentSpanId ?? null,
      timestamp: trace.timestamp,
      model: trace.model ?? "",
      query: trace.query,
      context: trace.context ?? "",
      response: trace.response,
      response_length: trace.responseLength,
      latency_ms: trace.latencyMs,
      ttfb_ms: trace.timeToFirstTokenMs ?? null,
      streaming_ms: trace.streamingDurationMs ?? null,
      tokens_prompt: trace.tokensPrompt ?? null,
      tokens_completion: trace.tokensCompletion ?? null,
      tokens_total: trace.tokensTotal ?? null,
      status: trace.status ?? null,
      status_text: trace.statusText ?? null,
      finish_reason: trace.finishReason ?? null,
      response_id: trace.responseId ?? null,
      system_fingerprint: trace.systemFingerprint ?? null,
      metadata_json: trace.metadata ? JSON.stringify(trace.metadata) : "",
      headers_json: trace.headers ? JSON.stringify(trace.headers) : "",
    };
  }

  /**
   * Ingest a trace event
   * 1. Validates JWT token
   * 2. Gets Tinybird token for tenant
   * 3. Forwards to Tinybird Events API
   */
  static async ingestTrace(
    trace: TraceEvent,
    jwtToken: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Validate JWT token
      const payload = TokenService.validateToken(jwtToken);
      if (!payload) {
        return { success: false, error: "Invalid or expired JWT token" };
      }

      // 2. Verify tenant context matches
      if (payload.tenantId !== trace.tenantId) {
        return {
          success: false,
          error: "Tenant ID mismatch between JWT and trace data",
        };
      }

      if (payload.projectId !== trace.projectId) {
        return {
          success: false,
          error: "Project ID mismatch between JWT and trace data",
        };
      }

      // 3. Get Tinybird token for this tenant
      const tinybirdToken = await TenantService.getTinybirdToken(
        payload.tenantId
      );
      if (!tinybirdToken) {
        return {
          success: false,
          error: `No Tinybird token provisioned for tenant ${payload.tenantId}`,
        };
      }

      // 4. Convert to Tinybird format
      const event = this.toTinybirdEvent(trace);

      // 5. Forward to Tinybird Events API
      // Use NDJSON format (newline-delimited JSON) which is required for Events API
      const url = `${TINYBIRD_HOST}/v0/events?name=${encodeURIComponent(
        TINYBIRD_DATASOURCE_NAME
      )}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tinybirdToken}`,
          "Content-Type": "application/x-ndjson",
        },
        body: JSON.stringify(event) + "\n", // NDJSON requires newline at end
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        return {
          success: false,
          error: `Tinybird API error: ${response.status} ${errorText}`,
        };
      }

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: errorMessage };
    }
  }
}
