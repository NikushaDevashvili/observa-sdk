/**
 * Regression test: tool definitions + OTEL metadata retention
 * and agentic loop linkage (LLM → tool → LLM).
 */

import { init } from "./src/index";
import {
  buildNormalizedLLMCall,
  buildOtelMetadata,
} from "./src/instrumentation/normalize";
import {
  agenticLoopFixture,
  toolRequestFixture,
  toolResponseFixture,
} from "./test-fixtures/telemetry-fixtures";

const observa = init({
  apiKey: "test-key",
  tenantId: "test-tenant",
  projectId: "test-project",
  mode: "development",
});

const events: Array<{ type: string; data: any }> = [];

const originalTrackLLMCall = observa.trackLLMCall.bind(observa);
const originalTrackToolCall = observa.trackToolCall.bind(observa);

observa.trackLLMCall = function (...args: any[]) {
  events.push({ type: "llm_call", data: args[0] });
  return originalTrackLLMCall(...args);
};

observa.trackToolCall = function (...args: any[]) {
  events.push({ type: "tool_call", data: args[0] });
  return originalTrackToolCall(...args);
};

console.log("\nTest: Tool definitions + OTEL metadata");

const normalized = buildNormalizedLLMCall({
  request: toolRequestFixture,
  response: toolResponseFixture,
  provider: "openai",
  toolDefsOverride: toolRequestFixture.tools,
});
const otelMetadata = buildOtelMetadata(normalized);

observa.trackLLMCall({
  model: toolRequestFixture.model,
  input: "What is the parental leave policy?",
  output: "I will search the policy docs.",
  inputMessages: normalized.inputMessages,
  outputMessages: normalized.outputMessages,
  inputTokens: normalized.usage.inputTokens,
  outputTokens: normalized.usage.outputTokens,
  totalTokens: normalized.usage.totalTokens,
  latencyMs: 10,
  providerName: "openai",
  toolDefinitions: normalized.toolDefinitions,
  metadata: otelMetadata,
});

const llmEvent = events.find((e) => e.type === "llm_call");
const hasToolDefinitions = Array.isArray(llmEvent?.data?.toolDefinitions);
const hasOtelTools = !!llmEvent?.data?.metadata?.["ai.prompt.tools"];

console.log("   Tool definitions attached:", hasToolDefinitions);
console.log("   OTEL ai.prompt.tools present:", hasOtelTools);

console.log("\nTest: Agentic loop linkage");

const agentSpanId = observa.trackLLMCall({
  model: toolRequestFixture.model,
  input: "Find policy and summarize.",
  output: null,
  latencyMs: 5,
  providerName: "openai",
  metadata: {
    "ai.agent.reasoning_summary": agenticLoopFixture.thoughtSummary,
  },
});

observa.trackToolCall({
  toolName: agenticLoopFixture.toolCall.toolName,
  args: agenticLoopFixture.toolCall.args,
  result: agenticLoopFixture.toolCall.result,
  resultStatus: "success",
  latencyMs: 12,
  parentSpanId: agentSpanId,
});

const followupNormalized = buildNormalizedLLMCall({
  request: toolRequestFixture,
  response: agenticLoopFixture.followupResponse,
  provider: "openai",
});

const followupSpanId = observa.trackLLMCall({
  model: toolRequestFixture.model,
  input: null,
  output:
    agenticLoopFixture.followupResponse.choices?.[0]?.message?.content || null,
  inputMessages: followupNormalized.inputMessages,
  outputMessages: followupNormalized.outputMessages,
  latencyMs: 8,
  providerName: "openai",
});

const toolEvent = events.find((e) => e.type === "tool_call");
const toolLinked = toolEvent?.data?.parentSpanId === agentSpanId;

console.log("   Tool call linked to LLM span:", toolLinked);
console.log("   Followup span created:", !!followupSpanId);

const allPassed = hasToolDefinitions && hasOtelTools && toolLinked;
if (allPassed) {
  console.log("\nTelemetry tests PASSED");
  process.exit(0);
} else {
  console.log("\nTelemetry tests FAILED");
  process.exit(1);
}
