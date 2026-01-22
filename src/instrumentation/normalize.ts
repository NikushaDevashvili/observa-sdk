/**
 * Shared normalization utilities for LLM telemetry.
 *
 * Centralizes tool/message normalization and OTEL metadata building
 * to keep provider wrappers consistent.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { OTEL_SEMCONV } from "./semconv";

export type NormalizedUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost?: number | null;
  inputCost?: number | null;
  outputCost?: number | null;
};

export type NormalizedLLMCall = {
  provider: string | null;
  model: string | null;
  responseModel: string | null;
  finishReason: string | null;
  toolDefinitions: Array<Record<string, any>> | null;
  inputMessages: Array<Record<string, any>> | null;
  outputMessages: Array<Record<string, any>> | null;
  usage: NormalizedUsage;
};

export function normalizeToolDefinitions(
  rawTools: any
): Array<Record<string, any>> | null {
  if (!rawTools) return null;

  let toolsArray: Array<{ tool: any; name?: string }> = [];
  if (Array.isArray(rawTools)) {
    toolsArray = rawTools.map((tool: any) => ({ tool }));
  } else if (rawTools instanceof Map) {
    const mapEntries: Array<[any, any]> = Array.from(rawTools.entries());
    toolsArray = mapEntries.map(([key, value]: [any, any]) => ({
      tool: value,
      name: String(key),
    }));
  } else if (typeof rawTools === "object") {
    toolsArray = Object.entries(rawTools).map(([key, value]: [string, any]) => ({
      tool: value,
      name: key,
    }));
  }

  const normalized = toolsArray.map(({ tool, name: keyName }) => {
    if (typeof tool === "function") {
      return {
        type: "function",
        name: tool.name || keyName || "unknown",
        description: tool.description || null,
        inputSchema: tool.parameters || tool.schema || {},
      };
    }
    if (tool && typeof tool === "object") {
      return {
        type: tool.type || "function",
        name: tool.name || tool.function?.name || keyName || "unknown",
        description: tool.description || tool.function?.description || null,
        inputSchema:
          tool.parameters ||
          tool.schema ||
          tool.inputSchema ||
          tool.function?.parameters ||
          {},
      };
    }
    return {
      type: "function",
      name: keyName || "unknown",
      description: null,
      inputSchema: {},
    };
  });

  return normalized.length > 0 ? normalized : null;
}

export function normalizeMessages(messages: any): any[] {
  if (!messages) return [];
  if (Array.isArray(messages)) return messages;
  return [messages];
}

function normalizePromptAsMessages(prompt: any): any[] {
  if (!prompt) return [];
  if (Array.isArray(prompt)) return prompt;
  if (typeof prompt === "string") {
    return [{ role: "user", content: prompt }];
  }
  return [prompt];
}

export function extractInputMessages(request: any): any[] | null {
  if (!request) return null;
  if (request.messages) {
    const normalized = normalizeMessages(request.messages);
    return normalized.length > 0 ? normalized : null;
  }
  if (request.prompt) {
    const normalized = normalizePromptAsMessages(request.prompt);
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

export function extractOutputMessages(response: any): any[] | null {
  if (!response) return null;
  if (response.choices && Array.isArray(response.choices)) {
    const normalized = response.choices
      .map((choice: any) => {
        const message = choice?.message || choice?.delta || null;
        if (!message) return null;
        return {
          ...message,
          finish_reason: choice?.finish_reason ?? message?.finish_reason ?? null,
        };
      })
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }
  if (response.messages) {
    const normalized = normalizeMessages(response.messages);
    return normalized.length > 0 ? normalized : null;
  }
  if (response.content && Array.isArray(response.content)) {
    return [
      {
        role: response.role || "assistant",
        content: response.content,
      },
    ];
  }
  return null;
}

function normalizeUsageFromResponse(response: any): NormalizedUsage {
  const usage = response?.usage || {};
  const inputTokens =
    usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? null;
  const outputTokens =
    usage.completion_tokens ??
    usage.output_tokens ??
    usage.completionTokens ??
    null;
  const computedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0);
  const totalTokens =
    usage.total_tokens ??
    usage.totalTokens ??
    (computedTotal > 0 ? computedTotal : null);

  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    totalTokens: totalTokens ?? null,
  };
}

function extractFinishReason(response: any, outputMessages: any[] | null): string | null {
  if (response?.choices?.[0]?.finish_reason) {
    return response.choices[0].finish_reason;
  }
  if (response?.stop_reason) return response.stop_reason;
  if (response?.finishReason) return response.finishReason;
  if (outputMessages && outputMessages.length > 0) {
    const last = outputMessages[outputMessages.length - 1];
    return last?.finish_reason ?? null;
  }
  return null;
}

export function buildNormalizedLLMCall(options: {
  request: any;
  response?: any;
  provider?: string | null;
  usage?: Partial<NormalizedUsage> | null;
  toolDefsOverride?: any;
  cost?: number | null;
  inputCost?: number | null;
  outputCost?: number | null;
}): NormalizedLLMCall {
  const inputMessages = extractInputMessages(options.request);
  const outputMessages = extractOutputMessages(options.response);
  const usageFromResponse = normalizeUsageFromResponse(options.response);
  const usage: NormalizedUsage = {
    inputTokens:
      options.usage?.inputTokens ?? usageFromResponse.inputTokens ?? null,
    outputTokens:
      options.usage?.outputTokens ?? usageFromResponse.outputTokens ?? null,
    totalTokens:
      options.usage?.totalTokens ?? usageFromResponse.totalTokens ?? null,
    cost: options.cost ?? options.usage?.cost ?? null,
    inputCost: options.inputCost ?? options.usage?.inputCost ?? null,
    outputCost: options.outputCost ?? options.usage?.outputCost ?? null,
  };

  const toolDefinitions = normalizeToolDefinitions(
    options.toolDefsOverride ?? options.request?.tools
  );

  const model =
    options.request?.model ||
    options.response?.model ||
    options.request?.modelId ||
    null;
  const responseModel =
    options.response?.model || options.request?.model || null;

  return {
    provider: options.provider ?? null,
    model: model ? String(model) : null,
    responseModel: responseModel ? String(responseModel) : null,
    finishReason: extractFinishReason(options.response, outputMessages),
    toolDefinitions,
    inputMessages,
    outputMessages,
    usage,
  };
}

export function buildOtelMetadata(normalized: NormalizedLLMCall): Record<string, any> {
  const metadata: Record<string, any> = {};

  if (normalized.provider) {
    metadata[OTEL_SEMCONV.GEN_AI_SYSTEM] = normalized.provider;
  }
  if (normalized.model) {
    metadata[OTEL_SEMCONV.GEN_AI_REQUEST_MODEL] = normalized.model;
  }
  if (normalized.responseModel) {
    metadata[OTEL_SEMCONV.GEN_AI_RESPONSE_MODEL] = normalized.responseModel;
  }
  if (normalized.usage.inputTokens !== null) {
    metadata[OTEL_SEMCONV.GEN_AI_USAGE_INPUT_TOKENS] =
      normalized.usage.inputTokens;
  }
  if (normalized.usage.outputTokens !== null) {
    metadata[OTEL_SEMCONV.GEN_AI_USAGE_OUTPUT_TOKENS] =
      normalized.usage.outputTokens;
  }
  if (normalized.usage.totalTokens !== null) {
    metadata[OTEL_SEMCONV.GEN_AI_USAGE_TOTAL_TOKENS] =
      normalized.usage.totalTokens;
  }
  if (normalized.usage.cost !== null && normalized.usage.cost !== undefined) {
    metadata[OTEL_SEMCONV.GEN_AI_USAGE_COST] = normalized.usage.cost;
  }
  if (normalized.finishReason) {
    metadata[OTEL_SEMCONV.GEN_AI_FINISH_REASONS] = [normalized.finishReason];
  }
  if (normalized.toolDefinitions) {
    metadata[OTEL_SEMCONV.AI_PROMPT_TOOLS] = normalized.toolDefinitions;
  }
  if (normalized.inputMessages) {
    metadata[OTEL_SEMCONV.AI_PROMPT_MESSAGES] = normalized.inputMessages;
  }
  if (normalized.outputMessages) {
    metadata[OTEL_SEMCONV.AI_RESPONSE_MESSAGES] = normalized.outputMessages;
  }

  return metadata;
}

export function buildAgenticMetadata(options: {
  reasoningSummary?: string | null;
}): Record<string, any> {
  const metadata: Record<string, any> = {};
  if (options.reasoningSummary) {
    metadata["ai.agent.reasoning_summary"] = options.reasoningSummary;
  }
  return metadata;
}
