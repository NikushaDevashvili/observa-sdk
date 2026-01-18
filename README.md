# Observa SDK

Enterprise-grade observability SDK for AI applications. Track and monitor LLM interactions with zero friction.

## Installation

```bash
npm install observa-sdk
```

## Getting Started

### 1. Sign Up

Get your API key by signing up at [https://app.observa.ai/signup](https://app.observa.ai/signup) (or your Observa API endpoint).

The signup process automatically:

- Creates your tenant account
- Sets up a default "Production" project
- Provisions your Tinybird token
- Generates your JWT API key

You'll receive your API key immediately after signup.

### 2. Install SDK

```bash
npm install observa-sdk
```

### 3. Initialize SDK

```typescript
import { init } from "observa-sdk";

const observa = init({
  apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", // Your API key from signup
});
```

## Quick Start

### Auto-Capture with OpenAI (Recommended)

The easiest way to track LLM calls is using the `observeOpenAI()` wrapper - it automatically captures 90%+ of your LLM interactions:

```typescript
import { init } from "observa-sdk";
import OpenAI from "openai";

// Initialize Observa
const observa = init({
  apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", // Your API key from signup
});

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Wrap with Observa (automatic tracing)
const wrappedOpenAI = observa.observeOpenAI(openai, {
  name: 'my-app',
  userId: 'user_123',
  redact: (data) => {
    // Optional: Scrub sensitive data before sending to Observa
    if (data?.messages) {
      return { ...data, messages: '[REDACTED]' };
    }
    return data;
  }
});

// Use wrapped client - automatically tracked!
const response = await wrappedOpenAI.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
});

// Streaming also works automatically
const stream = await wrappedOpenAI.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Auto-Capture with Anthropic

Works the same way with Anthropic:

```typescript
import { init } from "observa-sdk";
import Anthropic from "@anthropic-ai/sdk";

const observa = init({
  apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Wrap with Observa (automatic tracing)
const wrappedAnthropic = observa.observeAnthropic(anthropic, {
  name: 'my-app',
  userId: 'user_123',
});

// Use wrapped client - automatically tracked!
const response = await wrappedAnthropic.messages.create({
  model: 'claude-3-opus-20240229',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Auto-Capture with Vercel AI SDK

Vercel AI SDK is a unified SDK that works with multiple providers (OpenAI, Anthropic, Google, etc.).

#### Installation

First, install the required packages:

```bash
npm install observa-sdk ai @ai-sdk/openai @ai-sdk/anthropic
# or for other providers:
npm install @ai-sdk/google @ai-sdk/cohere
```

#### Basic Example (Node.js/Server)

```typescript
import { init } from "observa-sdk";
import { generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const observa = init({
  apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
});

// Wrap Vercel AI SDK functions (automatic tracing)
const ai = observa.observeVercelAI({ generateText, streamText }, {
  name: 'my-app',
  userId: 'user_123',
});

// Use wrapped functions - automatically tracked!
const result = await ai.generateText({
  model: openai('gpt-4'),
  prompt: 'Hello!',
});

// Streaming also works automatically
const stream = await ai.streamText({
  model: openai('gpt-4'),
  prompt: 'Tell me a joke',
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

#### Next.js App Router Example

For Next.js applications, use the route handler pattern:

```typescript
// app/api/chat/route.ts
import { streamText, UIMessage, convertToModelMessages } from "ai";
import { init } from "observa-sdk";
import { openai } from "@ai-sdk/openai";

const observa = init({
  apiKey: process.env.OBSERVA_API_KEY!,
  apiUrl: process.env.OBSERVA_API_URL,
});

const ai = observa.observeVercelAI({ streamText }, {
  name: "my-nextjs-app",
});

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = await ai.streamText({
    model: openai("gpt-4"),
    messages: await convertToModelMessages(messages),
  });

  // Return streaming response for Next.js
  return result.toUIMessageStreamResponse();
}
```

#### Client-Side with React (useChat Hook)

```typescript
// app/page.tsx
"use client";
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: "/api/chat",
  });

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>{message.content}</div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

#### With Tools/Function Calling

Observa automatically tracks tool calls:

```typescript
import { z } from "zod";

const result = await ai.streamText({
  model: openai("gpt-4"),
  messages: [...],
  tools: {
    getWeather: {
      description: "Get the weather for a location",
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => {
        // Tool implementation - automatically tracked by Observa
        return { temperature: 72, condition: "sunny" };
      },
    },
  },
});
```

#### Model Format Options

Vercel AI SDK supports two model formats:

1. **Provider function** (recommended):
```typescript
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

model: openai("gpt-4")
model: anthropic("claude-3-opus-20240229")
```

2. **String format** (for AI Gateway):
```typescript
model: "openai/gpt-4"
model: "anthropic/claude-3-opus-20240229"
```

#### Error Handling

Errors are automatically tracked:

```typescript
try {
  const result = await ai.generateText({
    model: openai("gpt-4"),
    prompt: "Hello!",
  });
} catch (error) {
  // Error is automatically tracked in Observa
  console.error("LLM call failed:", error);
}
```

### Manual Tracking (Advanced)

For more control over what gets tracked, use the manual tracking methods:

```typescript
// Use trackLLMCall for fine-grained control
const spanId = observa.trackLLMCall({
  model: 'gpt-4',
  input: 'Hello!',
  output: 'Hi there!',
  inputTokens: 10,
  outputTokens: 5,
  latencyMs: 1200,
  operationName: 'chat',
  providerName: 'openai',
});
```

See the [API Reference](#api-reference) section for all available methods.

## Multi-Tenant Architecture

Observa SDK uses a **multi-tenant shared runtime architecture** for optimal cost, scalability, and operational simplicity.

### Architecture Pattern

- **Shared Infrastructure**: Single Tinybird/ClickHouse cluster shared across all tenants
- **Data Isolation**: Multi-layer isolation via partitioning, token scoping, and row-level security
- **Performance**: Partitioned by tenant_id for efficient queries
- **Security**: JWT-based authentication with automatic tenant context extraction

### Data Storage

All tenant data is stored in a single shared table with:

- **Partitioning**: `PARTITION BY (tenant_id, toYYYYMM(date))`
- **Ordering**: `ORDER BY (tenant_id, project_id, timestamp, trace_id)`
- **Isolation**: Physical separation at partition level + logical separation via token scoping

### Security Model

1. **JWT Authentication**: API keys are JWTs encoding tenant/project context
2. **Token Scoping**: Each tenant gets a Tinybird token scoped to their `tenant_id`
3. **Automatic Filtering**: All queries automatically filtered by tenant context
4. **Row-Level Security**: Token-based access control prevents cross-tenant access

## JWT API Key Format

The SDK supports JWT-formatted API keys that encode tenant context:

```json
{
  "tenantId": "acme_corp",
  "projectId": "prod_app",
  "environment": "prod",
  "iat": 1234567890,
  "exp": 1234654290
}
```

**JWT Structure**:

- `tenantId` (required): Unique identifier for the tenant/organization
- `projectId` (required): Project identifier within the tenant
- `environment` (optional): `"dev"` or `"prod"` (defaults to `"dev"`)
- `iat` (optional): Issued at timestamp
- `exp` (optional): Expiration timestamp

When using a JWT API key, the SDK automatically extracts `tenantId` and `projectId` - you don't need to provide them in the config.

## Configuration

```typescript
interface ObservaInitConfig {
  // API key (JWT or legacy format)
  apiKey: string;

  // Tenant context (optional if API key is JWT, required for legacy keys)
  tenantId?: string;
  projectId?: string;
  environment?: "dev" | "prod";

  // Observa backend URL (optional, defaults to https://api.observa.ai)
  apiUrl?: string;

  // SDK behavior
  mode?: "development" | "production";
  sampleRate?: number; // 0..1, default: 1.0
  maxResponseChars?: number; // default: 50000
}
```

### Options

- **apiKey**: Your Observa API key (JWT format recommended)
- **tenantId** / **projectId**: Required only for legacy API keys
- **environment**: `"dev"` or `"prod"` (defaults to `"dev"`)
- **apiUrl**: Observa backend URL (optional, defaults to `https://api.observa.ai`)
- **mode**: SDK mode - `"development"` logs traces to console, `"production"` sends to Observa
- **sampleRate**: Fraction of traces to record (0.0 to 1.0)
- **maxResponseChars**: Maximum response size to capture (prevents huge payloads)

## API Reference

### `init(config: ObservaInitConfig)`

Initialize the Observa SDK instance.

**Example:**
```typescript
import { init } from "observa-sdk";

const observa = init({
  apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", // Your JWT API key
  apiUrl: "https://api.observa.ai", // Optional, defaults to https://api.observa.ai
  environment: "prod", // Optional, defaults to "dev"
  mode: "production", // Optional, "development" or "production"
  sampleRate: 1.0, // Optional, 0.0 to 1.0, default: 1.0
  maxResponseChars: 50000, // Optional, default: 50000
});
```

### `observa.observeOpenAI(client, options?)`

Wrap an OpenAI client with automatic tracing. This is the **recommended** way to track LLM calls.

**Parameters:**
- `client` (required): OpenAI client instance
- `options` (optional):
  - `name` (optional): Application/service name
  - `tags` (optional): Array of tags
  - `userId` (optional): User identifier
  - `sessionId` (optional): Session identifier
  - `redact` (optional): Function to sanitize data before sending to Observa

**Returns**: Wrapped OpenAI client (use it exactly like the original client)

**Example:**
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const wrapped = observa.observeOpenAI(openai, {
  name: 'my-app',
  userId: 'user_123',
  redact: (data) => {
    // Sanitize sensitive data
    if (data?.messages) {
      return { ...data, messages: '[REDACTED]' };
    }
    return data;
  }
});

// Use wrapped client - automatically tracked!
const response = await wrapped.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### `observa.observeAnthropic(client, options?)`

Wrap an Anthropic client with automatic tracing. Same API as `observeOpenAI()`.

**Example:**
```typescript
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const wrapped = observa.observeAnthropic(anthropic, {
  name: 'my-app',
  redact: (data) => ({ ...data, messages: '[REDACTED]' })
});

// Use wrapped client - automatically tracked!
const response = await wrapped.messages.create({
  model: 'claude-3-opus-20240229',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### `observa.observeVercelAI(aiSdk, options?)`

Wrap Vercel AI SDK functions (`generateText`, `streamText`) with automatic tracing. Vercel AI SDK is a unified SDK that works with multiple providers (OpenAI, Anthropic, Google, etc.).

**Parameters:**
- `aiSdk` (required): Object containing Vercel AI SDK functions (e.g., `{ generateText, streamText }`)
- `options` (optional):
  - `name` (optional): Application/service name
  - `tags` (optional): Array of tags
  - `userId` (optional): User identifier
  - `sessionId` (optional): Session identifier
  - `redact` (optional): Function to sanitize data before sending to Observa

**Returns**: Wrapped AI SDK object with the same functions (use them exactly like the original functions)

**Example:**
```typescript
import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

const ai = observa.observeVercelAI({ generateText, streamText }, {
  name: 'my-app',
  userId: 'user_123',
  redact: (data) => {
    // Sanitize sensitive data
    if (data?.prompt) {
      return { ...data, prompt: '[REDACTED]' };
    }
    return data;
  }
});

// Use wrapped functions - automatically tracked!
const result = await ai.generateText({
  model: openai('gpt-4'),
  prompt: 'Hello!',
});

// Streaming also works automatically
const stream = await ai.streamText({
  model: openai('gpt-4'),
  prompt: 'Tell me a joke',
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

### `observa.startTrace(options)`

Start a new trace for manual trace management. Returns the trace ID.

**Parameters:**
- `options.name` (optional): Trace name
- `options.metadata` (optional): Custom metadata object
- `options.conversationId` (optional): Conversation identifier
- `options.sessionId` (optional): Session identifier
- `options.userId` (optional): User identifier

**Returns**: `string` - The trace ID

**Example:**
```typescript
const traceId = observa.startTrace({
  name: "RAG Query",
  conversationId: "conv-123",
  userId: "user-456",
  metadata: { feature: "chat", version: "2.0" }
});
```

### `observa.endTrace(options)`

End the current trace and send all buffered events. Must be called after `startTrace()`.

**Parameters:**
- `options.outcome` (optional): `"success"` | `"error"` | `"timeout"` (default: `"success"`)

**Returns**: `Promise<string>` - The trace ID

**Example:**
```typescript
await observa.endTrace({ outcome: "success" });
```

### `observa.trackLLMCall(options)` ⭐ NEW - Full OTEL Support

Track an LLM call with complete OTEL compliance. **This is the recommended method** for tracking LLM calls.

**Parameters:**
- `model` (required): Model name
- `input`, `output`: Input/output text
- `inputTokens`, `outputTokens`, `totalTokens`: Token counts
- `latencyMs` (required): Latency in milliseconds
- `operationName`: OTEL operation name ("chat", "text_completion", "generate_content")
- `providerName`: Provider name ("openai", "anthropic", etc.) - auto-inferred from model if not provided
- `responseModel`: Actual model used (vs requested)
- `topK`, `topP`, `frequencyPenalty`, `presencePenalty`, `stopSequences`, `seed`: Sampling parameters
- `inputCost`, `outputCost`: Structured cost tracking
- `inputMessages`, `outputMessages`, `systemInstructions`: Structured message objects
- `serverAddress`, `serverPort`: Server metadata
- `conversationIdOtel`: OTEL conversation ID
- And more... (see SDK_SOTA_IMPLEMENTATION.md for complete list)

**Example:**
```typescript
const spanId = observa.trackLLMCall({
  model: "gpt-4-turbo",
  input: "What is AI?",
  output: "AI is...",
  inputTokens: 10,
  outputTokens: 50,
  latencyMs: 1200,
  operationName: "chat",
  providerName: "openai", // Auto-inferred if not provided
  temperature: 0.7,
  topP: 0.9,
  inputCost: 0.00245,
  outputCost: 0.01024
});
```

### `observa.trackEmbedding(options)` ⭐ NEW

Track an embedding operation with full OTEL support.

**Example:**
```typescript
const spanId = observa.trackEmbedding({
  model: "text-embedding-ada-002",
  dimensionCount: 1536,
  inputTokens: 10,
  outputTokens: 1536,
  latencyMs: 45,
  cost: 0.0001
});
```

### `observa.trackVectorDbOperation(options)` ⭐ NEW

Track vector database operations (Pinecone, Weaviate, Qdrant, etc.).

**Example:**
```typescript
const spanId = observa.trackVectorDbOperation({
  operationType: "vector_search",
  indexName: "documents",
  vectorDimensions: 1536,
  resultsCount: 10,
  latencyMs: 30,
  cost: 0.0005,
  providerName: "pinecone"
});
```

### `observa.trackCacheOperation(options)` ⭐ NEW

Track cache hit/miss operations.

**Example:**
```typescript
const spanId = observa.trackCacheOperation({
  cacheBackend: "redis",
  hitStatus: "hit",
  latencyMs: 2,
  savedCost: 0.01269
});
```

### `observa.trackAgentCreate(options)` ⭐ NEW

Track agent creation.

**Example:**
```typescript
const spanId = observa.trackAgentCreate({
  agentName: "Customer Support Agent",
  toolsBound: ["web_search", "database_query"],
  modelConfig: { model: "gpt-4-turbo", temperature: 0.7 }
});
```

### `observa.trackToolCall(options)` - Enhanced

Track a tool call with OTEL standardization.

**New Parameters:**
- `toolType`: "function" | "extension" | "datastore"
- `toolDescription`: Tool description
- `toolCallId`: Unique tool invocation ID
- `errorType`, `errorCategory`: Structured error classification

### `observa.trackRetrieval(options)` - Enhanced

Track retrieval operations with vector metadata.

**New Parameters:**
- `embeddingModel`: Model used for embeddings
- `embeddingDimensions`: Vector dimensions
- `vectorMetric`: Similarity metric
- `rerankScore`, `fusionMethod`, `qualityScore`: Quality metrics

### `observa.trackError(options)` - Enhanced

Track errors with structured classification.

**New Parameters:**
- `errorCategory`: Error category
- `errorCode`: Error code

### `observa.trackFeedback(options)`

Track user feedback (likes, dislikes, ratings, corrections) for AI interactions.

**Parameters**:

- `options.type` (required): Feedback type - `"like"` | `"dislike"` | `"rating"` | `"correction"`
- `options.rating` (optional): Rating value (1-5 scale, automatically clamped). Required for `"rating"` type.
- `options.comment` (optional): User comment/feedback text
- `options.outcome` (optional): Outcome classification - `"success"` | `"failure"` | `"partial"`
- `options.conversationId` (optional): Conversation identifier for context
- `options.sessionId` (optional): Session identifier for context
- `options.userId` (optional): User identifier for context
- `options.messageIndex` (optional): Position in conversation (1, 2, 3...)
- `options.parentMessageId` (optional): For threaded conversations
- `options.agentName` (optional): Agent/application name
- `options.version` (optional): Application version
- `options.route` (optional): API route/endpoint
- `options.parentSpanId` (optional): Attach feedback to a specific span (e.g., LLM call span)
- `options.spanId` (optional): Custom span ID for feedback (auto-generated if not provided)

**Returns**: `string` - The span ID of the feedback event

**Examples**:

#### Basic Like/Dislike Feedback

```typescript
// User clicks "like" button after receiving AI response
const feedbackSpanId = observa.trackFeedback({
  type: "like",
  outcome: "success",
  conversationId: "conv-123",
  userId: "user-456",
});

// User clicks "dislike" button
observa.trackFeedback({
  type: "dislike",
  outcome: "failure",
  comment: "The answer was incorrect",
  conversationId: "conv-123",
  userId: "user-456",
});
```

#### Rating Feedback (1-5 Scale)

```typescript
// User provides a 5-star rating
observa.trackFeedback({
  type: "rating",
  rating: 5, // Automatically clamped to 1-5 range
  comment: "Excellent response!",
  outcome: "success",
  conversationId: "conv-123",
  userId: "user-456",
});

// Rating is automatically validated (e.g., 10 becomes 5, -1 becomes 1)
observa.trackFeedback({
  type: "rating",
  rating: 10, // Will be clamped to 5
  conversationId: "conv-123",
});
```

#### Correction Feedback

```typescript
// User provides correction/feedback
observa.trackFeedback({
  type: "correction",
  comment: "The capital of France is Paris, not Lyon",
  outcome: "partial",
  conversationId: "conv-123",
  userId: "user-456",
});
```

#### Linking Feedback to Specific Spans

```typescript
// Start a trace and track LLM call
const traceId = observa.startTrace({
  conversationId: "conv-123",
  userId: "user-456",
});

const llmSpanId = observa.trackLLMCall({
  model: "gpt-4",
  input: "What is the capital of France?",
  output: "The capital of France is Paris.",
  // ... other LLM call data
});

// Link feedback directly to the LLM call span
observa.trackFeedback({
  type: "like",
  parentSpanId: llmSpanId, // Attach feedback to the specific LLM call
  conversationId: "conv-123",
  userId: "user-456",
});
```

#### Full Context Feedback

```typescript
// Track feedback with complete context for analytics
observa.trackFeedback({
  type: "rating",
  rating: 4,
  comment: "Good answer, but could be more detailed",
  outcome: "partial",
  conversationId: "conv-123",
  sessionId: "session-789",
  userId: "user-456",
  messageIndex: 3,
  agentName: "customer-support-bot",
  version: "v2.1.0",
  route: "/api/chat",
});
```

#### Feedback in Conversation Flow

```typescript
// Track feedback as part of a conversation
const traceId = observa.startTrace({
  conversationId: "conv-123",
  sessionId: "session-789",
  userId: "user-456",
  messageIndex: 1,
});

// ... perform AI operations ...

// User provides feedback after message 1
observa.trackFeedback({
  type: "like",
  conversationId: "conv-123",
  sessionId: "session-789",
  userId: "user-456",
  messageIndex: 1, // Link to specific message in conversation
});

await observa.endTrace();
```

**Best Practices**:

1. **Always include context**: Provide `conversationId`, `userId`, and `sessionId` when available for better analytics
2. **Link to spans**: Use `parentSpanId` to attach feedback to specific LLM calls or operations
3. **Use appropriate types**: 
   - `"like"` / `"dislike"` for binary feedback
   - `"rating"` for 1-5 star ratings
   - `"correction"` for user corrections or detailed feedback
4. **Include comments**: Comments provide valuable qualitative feedback for improving AI responses
5. **Set outcome**: Use `outcome` to classify feedback (`"success"` for positive, `"failure"` for negative, `"partial"` for mixed)

## Data Captured

The SDK automatically captures:

- **Request Data**: Query, context, model, metadata
- **Response Data**: Full response text, response length
- **Token Usage**: Prompt tokens, completion tokens, total tokens
- **Performance Metrics**: Latency, time-to-first-token, streaming duration
- **Response Metadata**: Status codes, finish reasons, response IDs
- **Trace Information**: Trace ID, span ID, timestamps

## Development Mode

In development mode (`mode: "development"`), the SDK:

- Logs beautifully formatted traces to the console
- Still sends data to Observa (for testing)
- Shows tenant context, performance metrics, and token usage

## Production Mode

In production mode (`mode: "production"` or `NODE_ENV=production`):

- Data is sent to Observa backend
- No console logs (except errors)
- Optimized for performance

## Multi-Tenant Isolation Guarantees

1. **Storage Layer**: Data partitioned by `tenant_id` (physical separation)
2. **Application Layer**: JWT encodes tenant context (logical separation)
3. **API Layer**: Token-scoped access (row-level security)
4. **Query Layer**: Automatic tenant filtering (no cross-tenant queries possible)

## Browser & Node.js Support

The SDK works in both browser and Node.js environments:

- **Browser**: Uses `atob` for base64 decoding
- **Node.js**: Uses `Buffer` for base64 decoding
- **Universal**: No environment-specific dependencies

## Onboarding Flow

1. **Sign Up**: Visit the signup page and provide your email and company name
2. **Get API Key**: Receive your JWT API key immediately
3. **Install SDK**: `npm install observa-sdk`
4. **Initialize**: Use your API key to initialize the SDK
5. **Start Tracking**: Begin tracking your AI interactions

The entire onboarding process takes less than 5 minutes, and you can start tracking traces immediately after signup.

## License

MIT
