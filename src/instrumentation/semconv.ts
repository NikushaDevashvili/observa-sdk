/**
 * OTEL Semantic Convention Mappings
 * 
 * Uses snake_case gen_ai.* attributes (OTEL v1.30+)
 * Maps OpenAI/Anthropic responses to OTEL-compliant attributes
 */

// OTEL Semantic Convention Mappings (snake_case - OTEL v1.30+)
export const OTEL_SEMCONV = {
  // Standard GenAI Attributes (Snake Case)
  GEN_AI_SYSTEM: 'gen_ai.system',
  GEN_AI_REQUEST_MODEL: 'gen_ai.request.model',
  GEN_AI_RESPONSE_MODEL: 'gen_ai.response.model',
  GEN_AI_USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  GEN_AI_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  
  // Observa Internal Attributes
  OBSERVA_TRACE_ID: 'observa.trace_id',
  OBSERVA_SPAN_ID: 'observa.span_id',
  OBSERVA_VERSION: 'observa.sdk_version',
} as const;

/**
 * Helper to map OpenAI response to OTEL attributes
 */
export function mapOpenAIToOTEL(request: any, response: any) {
  return {
    [OTEL_SEMCONV.GEN_AI_SYSTEM]: 'openai',
    [OTEL_SEMCONV.GEN_AI_REQUEST_MODEL]: request.model,
    [OTEL_SEMCONV.GEN_AI_RESPONSE_MODEL]: response?.model || request.model,
    [OTEL_SEMCONV.GEN_AI_USAGE_INPUT_TOKENS]: response?.usage?.prompt_tokens,
    [OTEL_SEMCONV.GEN_AI_USAGE_OUTPUT_TOKENS]: response?.usage?.completion_tokens,
    [OTEL_SEMCONV.GEN_AI_FINISH_REASONS]: response?.choices?.map((c: any) => c.finish_reason),
  };
}

/**
 * Helper to map Anthropic response to OTEL attributes
 */
export function mapAnthropicToOTEL(request: any, response: any) {
  return {
    [OTEL_SEMCONV.GEN_AI_SYSTEM]: 'anthropic',
    [OTEL_SEMCONV.GEN_AI_REQUEST_MODEL]: request.model,
    [OTEL_SEMCONV.GEN_AI_RESPONSE_MODEL]: response?.model || request.model,
    [OTEL_SEMCONV.GEN_AI_USAGE_INPUT_TOKENS]: response?.usage?.input_tokens,
    [OTEL_SEMCONV.GEN_AI_USAGE_OUTPUT_TOKENS]: response?.usage?.output_tokens,
    [OTEL_SEMCONV.GEN_AI_FINISH_REASONS]: response?.stop_reason ? [response.stop_reason] : null,
  };
}
