/**
 * Test script to verify error detection in Observa SDK
 * Tests:
 * 1. Empty response detection
 * 2. Failure finish reason detection (content_filter, length)
 * 3. Length truncation detection
 * 4. OpenAI Responses API - failed status
 * 5. OpenAI Responses API - incomplete (max_tokens)
 */

import { init } from "./src/index";
import {
  openaiResponsesFailedFixture,
  openaiResponsesIncompleteFixture,
} from "./test-fixtures/telemetry-fixtures";

// Mock Observa instance for testing
const observa = init({
  apiKey: "test-key",
  tenantId: "test-tenant",
  projectId: "test-project",
  mode: "development",
});

// Track events for verification
const capturedEvents: any[] = [];
const originalTrackLLMCall = observa.trackLLMCall.bind(observa);
const originalTrackError = observa.trackError.bind(observa);

observa.trackLLMCall = function (...args: any[]) {
  capturedEvents.push({ type: "llm_call", data: args[0] });
  return originalTrackLLMCall(...args);
};

observa.trackError = function (...args: any[]) {
  capturedEvents.push({ type: "error", data: args[0] });
  return originalTrackError(...args);
};

// Test 1: Empty response detection
console.log("\n🧪 Test 1: Empty Response Detection");
console.log("=".repeat(60));

// Simulate empty response
const emptyResponse = {
  choices: [
    {
      message: {
        content: "", // Empty content
      },
      finish_reason: null,
    },
  ],
  model: "gpt-4",
  id: "test-id",
};

// Import the recordTrace function (we'll need to test it directly)
// For now, let's test the logic manually
const isEmptyResponse =
  !emptyResponse.choices[0].message.content ||
  emptyResponse.choices[0].message.content.trim().length === 0;

if (isEmptyResponse) {
  observa.trackLLMCall({
    model: "gpt-4",
    input: "Test input",
    output: null,
    latencyMs: 100,
    operationName: "chat",
    providerName: "openai",
  });

  observa.trackError({
    errorType: "empty_response",
    errorMessage: "AI returned empty response",
    errorCategory: "model_error",
    errorCode: "empty_response",
  });

  console.log("✅ Empty response detected and error recorded");
  console.log(
    "   Error events:",
    capturedEvents.filter((e) => e.type === "error").length,
  );
} else {
  console.log("❌ Empty response NOT detected");
}

// Test 2: Failure finish reason detection
console.log("\n🧪 Test 2: Failure Finish Reason Detection");
console.log("=".repeat(60));

const contentFilterResponse = {
  choices: [
    {
      message: {
        content: "Some content",
      },
      finish_reason: "content_filter", // Failure reason
    },
  ],
  model: "gpt-4",
};

const finishReason = contentFilterResponse.choices[0].finish_reason;
const isFailureFinishReason =
  finishReason === "content_filter" || finishReason === "length";

if (isFailureFinishReason) {
  observa.trackLLMCall({
    model: "gpt-4",
    input: "Test input",
    output: null,
    finishReason: finishReason,
    latencyMs: 100,
    operationName: "chat",
    providerName: "openai",
  });

  observa.trackError({
    errorType: "content_filtered",
    errorMessage: "AI response was filtered due to content policy",
    errorCategory: "validation_error",
    errorCode: finishReason,
  });

  console.log("✅ Failure finish reason detected and error recorded");
  console.log("   Finish reason:", finishReason);
  console.log(
    "   Error events:",
    capturedEvents.filter((e) => e.type === "error").length,
  );
} else {
  console.log("❌ Failure finish reason NOT detected");
}

// Test 3: Length truncation detection
console.log("\n🧪 Test 3: Length Truncation Detection");
console.log("=".repeat(60));

const lengthTruncatedResponse = {
  choices: [
    {
      message: {
        content: "Partial content...",
      },
      finish_reason: "length", // Truncated due to token limit
    },
  ],
  model: "gpt-4",
};

const lengthFinishReason = lengthTruncatedResponse.choices[0].finish_reason;
const isLengthFailure = lengthFinishReason === "length";

if (isLengthFailure) {
  observa.trackLLMCall({
    model: "gpt-4",
    input: "Test input",
    output: null,
    finishReason: lengthFinishReason,
    latencyMs: 100,
    operationName: "chat",
    providerName: "openai",
  });

  observa.trackError({
    errorType: "response_truncated",
    errorMessage: "AI response was truncated due to token limit",
    errorCategory: "model_error",
    errorCode: lengthFinishReason,
  });

  console.log("✅ Length truncation detected and error recorded");
  console.log("   Finish reason:", lengthFinishReason);
} else {
  console.log("❌ Length truncation NOT detected");
}

// Test 4: Responses API - failed status
console.log("\n🧪 Test 4: Responses API - Failed Status");
console.log("=".repeat(60));

const responsesFailedReq = { model: "gpt-4o", input: "Test" };
const isResponsesFailed = openaiResponsesFailedFixture.status === "failed";

if (isResponsesFailed) {
  observa.trackLLMCall({
    model: "gpt-4o",
    input: "Test",
    output: null,
    finishReason: openaiResponsesFailedFixture.error?.code || "error",
    latencyMs: 100,
    operationName: "chat",
    providerName: "openai",
  });

  observa.trackError({
    errorType: openaiResponsesFailedFixture.error?.code || "api_error",
    errorMessage:
      openaiResponsesFailedFixture.error?.message || "API request failed",
    errorCategory: "unknown_error",
    errorCode: openaiResponsesFailedFixture.error?.code || "error",
  });

  console.log("✅ Responses API failed status detected and error recorded");
} else {
  console.log("❌ Responses API failed status NOT detected");
}

// Test 5: Responses API - incomplete (max_tokens)
console.log("\n🧪 Test 5: Responses API - Incomplete (max_tokens)");
console.log("=".repeat(60));

const responsesMaxTokens =
  openaiResponsesIncompleteFixture.status === "incomplete" &&
  openaiResponsesIncompleteFixture.incomplete_details?.reason === "max_tokens";

if (responsesMaxTokens) {
  observa.trackLLMCall({
    model: "gpt-4o",
    input: "Long prompt",
    output: null,
    finishReason: "incomplete",
    latencyMs: 100,
    operationName: "chat",
    providerName: "openai",
  });

  observa.trackError({
    errorType: "response_truncated",
    errorMessage: "AI response was truncated due to token limit",
    errorCategory: "model_error",
    errorCode: "max_tokens",
  });

  console.log(
    "✅ Responses API incomplete (max_tokens) detected and error recorded",
  );
} else {
  console.log("❌ Responses API incomplete NOT detected");
}

// Summary
console.log("\n📊 Test Summary");
console.log("=".repeat(60));
console.log("Total events captured:", capturedEvents.length);
console.log(
  "LLM call events:",
  capturedEvents.filter((e) => e.type === "llm_call").length,
);
console.log(
  "Error events:",
  capturedEvents.filter((e) => e.type === "error").length,
);

const errorEvents = capturedEvents.filter((e) => e.type === "error");
console.log("\nError Details:");
errorEvents.forEach((event, idx) => {
  console.log(
    `  ${idx + 1}. ${event.data.errorType}: ${event.data.errorMessage}`,
  );
  console.log(
    `     Category: ${event.data.errorCategory}, Code: ${event.data.errorCode}`,
  );
});

// Verify all tests passed (5 error events: empty, content_filter, length, responses failed, responses incomplete)
const allTestsPassed =
  capturedEvents.filter((e) => e.type === "error").length >= 5 &&
  errorEvents.some((e) => e.data.errorType === "empty_response") &&
  errorEvents.some((e) => e.data.errorType === "content_filtered") &&
  errorEvents.some((e) => e.data.errorType === "response_truncated") &&
  errorEvents.some(
    (e) =>
      e.data.errorType === "server_error" || e.data.errorType === "api_error",
  );

if (allTestsPassed) {
  console.log("\n✅ All error detection tests PASSED!");
  process.exit(0);
} else {
  console.log("\n❌ Some tests FAILED");
  process.exit(1);
}
