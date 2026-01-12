# SDK Enhancements - Complete Implementation

## Summary

All requested enhancements have been successfully implemented in the Observa SDK:

✅ **Explicit methods for tool calls, retrievals, errors**
✅ **Span hierarchy support for nested operations**
✅ **Enhanced error tracking with stack traces**
✅ **Feedback tracking**

## New Methods Added

### 1. Manual Trace Management

#### `startTrace(options?)` → `string`
Start a new trace manually. Returns the trace ID.

```typescript
const traceId = observa.startTrace({
  name: "Customer Support Chat",
  conversationId: "conv-123",
  sessionId: "session-456",
  userId: "user-789",
  metadata: { channel: "web" }
});
```

#### `endTrace(options?)` → `Promise<string>`
End the current trace and send all events. Returns the trace ID.

```typescript
await observa.endTrace({ outcome: "success" });
```

### 2. Tool Call Tracking

#### `trackToolCall(options)` → `string`
Track a tool/function execution.

```typescript
const spanId = observa.trackToolCall({
  toolName: "web_search",
  args: { query: "weather today" },
  result: { results: [...] },
  resultStatus: "success",
  latencyMs: 245,
  errorMessage: null
});
```

**Parameters:**
- `toolName` (required): Name of the tool/function
- `args` (optional): Tool arguments
- `result` (optional): Tool result/output
- `resultStatus` (required): "success", "error", or "timeout"
- `latencyMs` (required): Execution latency in milliseconds
- `errorMessage` (optional): Error message if status is "error" or "timeout"

### 3. Retrieval Tracking

#### `trackRetrieval(options)` → `string`
Track a RAG/vector database retrieval operation.

```typescript
const spanId = observa.trackRetrieval({
  contextIds: ["doc-123", "doc-456"],
  contextHashes: ["hash-abc", "hash-def"],
  k: 3,
  similarityScores: [0.95, 0.87, 0.82],
  latencyMs: 180
});
```

**Parameters:**
- `latencyMs` (required): Retrieval latency in milliseconds
- `contextIds` (optional): Array of document/context IDs
- `contextHashes` (optional): Array of content hashes
- `k` (optional): Number of results retrieved
- `similarityScores` (optional): Array of similarity scores (0-1)

### 4. Error Tracking

#### `trackError(options)` → `string`
Track an error with automatic stack trace extraction.

```typescript
try {
  // Some operation
} catch (error) {
  observa.trackError({
    errorType: "tool_error",
    errorMessage: "Database connection failed",
    error: error, // Error object - stack trace extracted automatically
    context: { toolName: "database_query", attempt: 1 }
  });
}
```

**Parameters:**
- `errorType` (required): Error category (e.g., "tool_error", "llm_error", "retrieval_error", "timeout_error")
- `errorMessage` (required): Human-readable error message
- `error` (optional): Error object - stack trace extracted automatically if provided
- `stackTrace` (optional): Stack trace string (if error object not provided)
- `context` (optional): Additional error context

### 5. Feedback Tracking

#### `trackFeedback(options)` → `string`
Track user feedback (like/dislike/rating/correction).

```typescript
observa.trackFeedback({
  type: "rating",
  rating: 4,
  comment: "Helpful response, but could be more detailed",
  outcome: "success"
});
```

**Parameters:**
- `type` (required): "like", "dislike", "rating", or "correction"
- `rating` (optional): 1-5 scale (for "rating" type)
- `comment` (optional): User comment
- `outcome` (optional): "success", "failure", or "partial"

### 6. Output Tracking

#### `trackOutput(options)` → `string`
Track the final output/response.

```typescript
observa.trackOutput({
  finalOutput: "The weather is sunny and 72°F.",
  outputLength: 33
});
```

**Parameters:**
- `finalOutput` (optional): Final output text
- `outputLength` (optional): Length of output in characters

### 7. Span Hierarchy Support

#### `withSpan<T>(spanId, fn)` → `T`
Execute a function within a span context (for nested operations).

```typescript
const llmSpanId = observa.trackLLMCall({ ... });

// Tool calls nested under LLM call
observa.withSpan(llmSpanId, () => {
  observa.trackToolCall({ toolName: "calculator", ... });
  observa.trackToolCall({ toolName: "web_search", ... });
});
```

#### `withSpanAsync<T>(spanId, fn)` → `Promise<T>`
Execute an async function within a span context.

```typescript
const llmSpanId = observa.trackLLMCall({ ... });

await observa.withSpanAsync(llmSpanId, async () => {
  await observa.trackToolCall({ toolName: "api_call", ... });
});
```

## Complete Usage Example

```typescript
import { init } from "observa-sdk";

const observa = init({
  apiKey: process.env.OBSERVA_API_KEY!,
  environment: "prod",
});

// Start trace
const traceId = observa.startTrace({
  name: "AI Assistant",
  conversationId: "conv-123",
  userId: "user-789",
});

try {
  // Track retrieval
  const retrievalStart = Date.now();
  const context = await vectorDB.query(userQuery, { k: 3 });
  const retrievalSpanId = observa.trackRetrieval({
    contextIds: context.map(doc => doc.id),
    contextHashes: context.map(doc => hash(doc.content)),
    k: 3,
    similarityScores: context.map(doc => doc.score),
    latencyMs: Date.now() - retrievalStart,
  });

  // Track LLM call
  const llmStart = Date.now();
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: userQuery }],
  });

  const llmSpanId = observa.trackLLMCall({
    model: "gpt-4",
    input: userQuery,
    output: response.choices[0].message.content,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
    totalTokens: response.usage?.total_tokens,
    latencyMs: Date.now() - llmStart,
    finishReason: response.choices[0].finish_reason,
    responseId: response.id,
  });

  // Nested tool calls within LLM call
  observa.withSpan(llmSpanId, () => {
    const toolStart = Date.now();
    try {
      const result = await webSearch(userQuery);
      observa.trackToolCall({
        toolName: "web_search",
        args: { query: userQuery },
        result: result,
        resultStatus: "success",
        latencyMs: Date.now() - toolStart,
      });
    } catch (error) {
      observa.trackToolCall({
        toolName: "web_search",
        args: { query: userQuery },
        resultStatus: "error",
        latencyMs: Date.now() - toolStart,
        errorMessage: error.message,
      });
      observa.trackError({
        errorType: "tool_error",
        errorMessage: error.message,
        error: error, // Stack trace extracted automatically
      });
    }
  });

  // Track output
  observa.trackOutput({
    finalOutput: response.choices[0].message.content,
    outputLength: response.choices[0].message.content.length,
  });

  // End trace
  await observa.endTrace({ outcome: "success" });

} catch (error) {
  observa.trackError({
    errorType: "execution_error",
    errorMessage: error.message,
    error: error,
  });
  await observa.endTrace({ outcome: "error" });
  throw error;
}
```

## Backward Compatibility

All existing functionality remains unchanged:

- ✅ `observa.track()` method still works (automatic trace management)
- ✅ Existing code continues to work without changes
- ✅ Pretty logging in dev mode still works
- ✅ All configuration options unchanged

## Implementation Details

### Span Hierarchy

The SDK uses a `spanStack` to track parent-child relationships:

- When `startTrace()` is called, the root span ID is pushed onto the stack
- When `trackToolCall()`, `trackRetrieval()`, etc. are called, they use the top of the stack as the parent
- `withSpan()` temporarily pushes a span ID onto the stack, executes the function, then pops it
- This enables nested operations (e.g., tool calls within LLM calls)

### Error Tracking

The `trackError()` method automatically extracts stack traces from Error objects:

```typescript
observa.trackError({
  errorType: "tool_error",
  errorMessage: error.message,
  error: error, // Stack trace extracted automatically
});
```

If an Error object is provided, the stack trace is extracted automatically. You can also provide a `stackTrace` string directly.

### Event Batching

All events for a trace are accumulated in a buffer and sent together when:
- `endTrace()` is called (manual mode)
- `flush()` is called explicitly
- Buffer reaches maximum size (auto-flush)
- Periodic flush interval (every 5 seconds)

## Testing

Build the SDK to verify compilation:

```bash
cd observa-sdk
npm run build
```

Expected output:
- ✅ TypeScript compilation successful
- ✅ All types correct
- ✅ No errors

## Next Steps

1. **Test with your application** - Use the new methods in your code
2. **Verify in dashboard** - Check that nested spans appear correctly
3. **Review examples** - See `/Users/nickdevashvili/observa-api/SDK_IMPLEMENTATION_EXAMPLE.md` for more examples

## Files Modified

- `src/index.ts` - Added all new methods and span hierarchy support
  - Added `startTrace()`, `endTrace()` for manual trace management
  - Added `trackToolCall()`, `trackRetrieval()`, `trackError()`, `trackFeedback()`, `trackOutput()`
  - Added `withSpan()`, `withSpanAsync()` for nested operations
  - Added span hierarchy tracking (spanStack)
  - Updated CanonicalEvent interface to include all event types

## Type Definitions

All new methods are fully typed. See TypeScript definitions in `dist/index.d.ts`.







