/**
 * Error extraction utilities for provider-specific error handling
 * Extracts error codes, categories, and messages from provider SDK errors
 */

export interface ExtractedError {
  code: string;
  category: string;
  message: string;
  statusCode?: number;
}

/**
 * Error categories for classification
 */
export type ErrorCategory =
  | "authentication_error"
  | "rate_limit_error"
  | "validation_error"
  | "network_error"
  | "server_error"
  | "quota_error"
  | "model_error"
  | "timeout_error"
  | "unknown_error";

/**
 * Extract error code from provider error
 */
export function extractErrorCode(error: any, provider: string): string | null {
  if (!error) return null;

  // OpenAI errors
  if (provider === "openai" || provider === "vercel-ai") {
    if (error.code) return error.code;
    if (error.type) return error.type;
    if (error.status === 401) return "invalid_api_key";
    if (error.status === 429) return "rate_limit_exceeded";
    if (error.status === 400) return "invalid_request";
    if (error.status === 403) return "insufficient_quota";
    if (error.status === 404) return "model_not_found";
    if (error.status === 500) return "internal_server_error";
    if (error.status === 502) return "bad_gateway";
    if (error.status === 503) return "service_unavailable";
  }

  // Anthropic errors
  if (provider === "anthropic") {
    if (error.error?.type) return error.error.type;
    if (error.status === 401) return "invalid_api_key";
    if (error.status === 429) return "rate_limit_error";
    if (error.status === 400) return "invalid_request";
    if (error.status === 500) return "internal_server_error";
  }

  // Generic HTTP status codes
  if (error.status) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 403) return "forbidden";
    if (error.status === 404) return "not_found";
    if (error.status === 429) return "rate_limit_exceeded";
    if (error.status >= 500) return "server_error";
  }

  // Check error message for common patterns
  const message = String(error.message || error);
  if (message.toLowerCase().includes("timeout")) return "timeout_error";
  if (message.toLowerCase().includes("network")) return "network_error";
  if (message.toLowerCase().includes("connection")) return "connection_error";

  return null;
}

/**
 * Categorize error based on error object and provider
 */
export function categorizeError(error: any, provider: string): ErrorCategory {
  if (!error) return "unknown_error";

  const statusCode = error.status || error.statusCode || error.status_code;
  const errorCode = extractErrorCode(error, provider);
  const message = String(error.message || error.error?.message || error || "").toLowerCase();

  // Authentication errors
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    errorCode === "invalid_api_key" ||
    errorCode === "unauthorized" ||
    errorCode === "forbidden" ||
    message.includes("authentication") ||
    message.includes("unauthorized") ||
    message.includes("invalid api key") ||
    message.includes("invalid api_token")
  ) {
    return "authentication_error";
  }

  // Rate limit errors
  if (
    statusCode === 429 ||
    errorCode === "rate_limit_exceeded" ||
    errorCode === "rate_limit_error" ||
    message.includes("rate limit") ||
    message.includes("too many requests")
  ) {
    return "rate_limit_error";
  }

  // Validation errors
  if (
    statusCode === 400 ||
    errorCode === "invalid_request" ||
    message.includes("validation") ||
    message.includes("invalid") ||
    message.includes("bad request")
  ) {
    return "validation_error";
  }

  // Timeout errors
  if (
    errorCode === "timeout_error" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("request timeout")
  ) {
    return "timeout_error";
  }

  // Network errors
  if (
    errorCode === "network_error" ||
    errorCode === "connection_error" ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("eai_again")
  ) {
    return "network_error";
  }

  // Server errors
  if (
    statusCode >= 500 ||
    errorCode === "internal_server_error" ||
    errorCode === "server_error" ||
    errorCode === "bad_gateway" ||
    errorCode === "service_unavailable" ||
    message.includes("server error") ||
    message.includes("internal error")
  ) {
    return "server_error";
  }

  // Quota errors
  if (
    errorCode === "insufficient_quota" ||
    message.includes("quota") ||
    message.includes("billing") ||
    message.includes("credits")
  ) {
    return "quota_error";
  }

  // Model errors
  if (
    statusCode === 404 ||
    errorCode === "model_not_found" ||
    errorCode === "not_found" ||
    message.includes("model not found") ||
    message.includes("model unavailable")
  ) {
    return "model_error";
  }

  return "unknown_error";
}

/**
 * Extract comprehensive error information from provider error
 */
export function extractProviderError(
  error: any,
  provider: string
): ExtractedError {
  const code = extractErrorCode(error, provider) || "unknown_error";
  const category = categorizeError(error, provider);
  const statusCode = error.status || error.statusCode || error.status_code;

  // Extract error message
  let message = "An unknown error occurred";
  if (error.message) {
    message = error.message;
  } else if (error.error?.message) {
    message = error.error.message;
  } else if (error.response?.data?.error?.message) {
    message = error.response.data.error.message;
  } else if (typeof error === "string") {
    message = error;
  } else if (error.toString && error.toString() !== "[object Object]") {
    message = error.toString();
  }

  return {
    code,
    category,
    message,
    statusCode,
  };
}
