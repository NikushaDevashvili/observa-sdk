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

### JWT-based API Key (Recommended)

After signing up, you'll receive a JWT-formatted API key that automatically encodes your tenant and project context:

```typescript
import { init } from "observa-sdk";

// Initialize with JWT API key from signup (automatically extracts tenant/project context)
const observa = init({
  apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", // Your API key from signup
});

// Track AI interactions with simple wrapping
const response = await observa.track(
  { query: "What is the weather?" },
  () => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { /* ... */ },
    body: JSON.stringify({ /* ... */ }),
  })
);
```

### Legacy API Key Format

```typescript
// For backward compatibility, you can still provide tenantId/projectId explicitly
const observa = init({
  apiKey: "your-api-key",
  tenantId: "acme_corp",
  projectId: "prod_app",
  environment: "prod", // optional, defaults to "dev"
});
```

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
- **mode**: SDK mode - `"development"` logs traces to console, `"production"` sends to Observa
- **sampleRate**: Fraction of traces to record (0.0 to 1.0)
- **maxResponseChars**: Maximum response size to capture (prevents huge payloads)

## API Reference

### `init(config: ObservaInitConfig)`

Initialize the Observa SDK instance.

### `observa.track(event, action)`

Track an AI interaction.

**Parameters**:
- `event.query` (required): The user query/prompt
- `event.context` (optional): Additional context
- `event.model` (optional): Model identifier
- `event.metadata` (optional): Custom metadata
- `action`: Function that returns a `Promise<Response>` (typically a fetch call)

**Returns**: `Promise<Response>` (the original response, unmodified)

**Example**:
```typescript
const response = await observa.track(
  {
    query: "What is machine learning?",
    model: "gpt-4",
    metadata: { userId: "123" },
  },
  () => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "What is machine learning?" }],
    }),
  })
);
```

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

