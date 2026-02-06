/**
 * Test stream empty response detection
 */

import { wrapStream } from "./src/instrumentation/utils";

console.log("\n🧪 Test: Stream Empty Response Detection");
console.log("=".repeat(70));

// Simulate an async generator that yields empty chunks
async function* emptyStream() {
  // Yield chunks with no content
  yield { choices: [{ delta: { content: "" } }] };
  yield { choices: [{ delta: { content: "" } }] };
  // No actual content
}

// Simulate an async generator with content
async function* contentStream() {
  yield { choices: [{ delta: { content: "Hello" } }] };
  yield { choices: [{ delta: { content: " World" } }] };
}

// Simulate Responses API stream format
async function* responsesStream() {
  yield {
    type: "response.created",
    response: { id: "resp_1", status: "in_progress" },
  };
  yield { type: "response.output_text.delta", delta: "Hello" };
  yield { type: "response.output_text.delta", delta: " from " };
  yield { type: "response.output_text.delta", delta: "Responses API!" };
  yield {
    type: "response.completed",
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from Responses API!" }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
    },
  };
}

let errorDetected = false;
let completeCalled = false;

const onComplete = (data: any) => {
  completeCalled = true;
  const hasChatContent = !!data?.choices?.[0]?.message?.content;
  const hasResponsesContent = !!data?.output_text;
  console.log("✅ onComplete called with:", {
    hasChatContent,
    hasResponsesContent,
    contentLength:
      data?.choices?.[0]?.message?.content?.length ||
      data?.output_text?.length ||
      0,
  });
};

const onError = (error: any) => {
  errorDetected = true;
  console.log("🚨 onError called:", {
    name: error.name,
    message: error.message,
    errorType: error.errorType,
  });
};

// Test empty stream
console.log("\n📋 Test 1: Empty Stream");
(async () => {
  try {
    const wrapped = wrapStream(emptyStream(), onComplete, onError, "openai");
    // Consume the stream
    for await (const chunk of wrapped) {
      // Just consume
    }
    // Wait a bit for async callbacks
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (errorDetected && !completeCalled) {
      console.log("   ✅ Empty stream correctly detected and error reported");
    } else {
      console.log("   ❌ Empty stream NOT detected correctly");
      console.log("      errorDetected:", errorDetected);
      console.log("      completeCalled:", completeCalled);
    }
  } catch (e) {
    console.log("   Error:", e);
  }
})();

// Reset for next test
setTimeout(async () => {
  errorDetected = false;
  completeCalled = false;

  console.log("\n📋 Test 2: Stream with Content");
  try {
    const wrapped = wrapStream(contentStream(), onComplete, onError, "openai");
    for await (const chunk of wrapped) {
      // Just consume
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (!errorDetected && completeCalled) {
      console.log("   ✅ Stream with content correctly processed");
    } else {
      console.log("   ❌ Stream with content incorrectly flagged as error");
      console.log("      errorDetected:", errorDetected);
      console.log("      completeCalled:", completeCalled);
    }
  } catch (e) {
    console.log("   Error:", e);
  }

  // Test 3: Responses API stream format
  errorDetected = false;
  completeCalled = false;
  console.log("\n📋 Test 3: Responses API Stream Format");
  try {
    const wrapped = wrapStream(
      responsesStream(),
      onComplete,
      onError,
      "openai",
    );
    let chunkCount = 0;
    for await (const chunk of wrapped) {
      chunkCount++;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (!errorDetected && completeCalled) {
      console.log(
        `   ✅ Responses API stream correctly processed (chunks: ${chunkCount})`,
      );
    } else {
      console.log("   ❌ Responses API stream incorrectly flagged");
      console.log("      errorDetected:", errorDetected);
      console.log("      completeCalled:", completeCalled);
    }
  } catch (e) {
    console.log("   Error:", e);
  }

  console.log("\n✅ Stream detection tests completed");
}, 200);
