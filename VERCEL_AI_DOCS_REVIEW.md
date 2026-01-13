# Vercel AI SDK Documentation Review

## Issues Found When Comparing with Vercel's Official Documentation

Based on review of [Vercel's Next.js App Router guide](https://ai-sdk.dev/docs/getting-started/nextjs-app-router) and [Observa's Vercel AI integration docs](https://observa-app.vercel.app/docs/cookbooks/vercel-ai-integration), here are the discrepancies and missing information:

---

## 1. ❌ Missing: Next.js Route Handler Pattern

**Vercel's Pattern:**

```typescript
// app/api/chat/route.ts
import { streamText, UIMessage, convertToModelMessages } from "ai";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: "anthropic/claude-sonnet-4.5",
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

**Observa's Current Docs:** Only shows client-side usage with `stream.textStream`, missing the critical Next.js route handler pattern with `toUIMessageStreamResponse()`.

**Fix Needed:** Add a complete Next.js route handler example showing:

- How to wrap `streamText` with Observa
- How to use `toUIMessageStreamResponse()`
- How to handle `UIMessage` and `convertToModelMessages()`

---

## 2. ⚠️ Incomplete: Provider Package Installation

**Vercel's Requirement:**

```bash
pnpm add ai @ai-sdk/react zod
# Plus provider-specific packages:
pnpm add @ai-sdk/openai @ai-sdk/anthropic
```

**Observa's Current Docs:** Mentions installing `ai` but doesn't emphasize provider packages are required.

**Fix Needed:**

- Clearly state that provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) must be installed
- Show installation command with all required packages
- Explain that provider packages are separate from the core `ai` package

---

## 3. ⚠️ Unclear: Model Format Options

**Vercel Supports Two Formats:**

1. String format: `"anthropic/claude-sonnet-4.5"`
2. Provider function: `openai('gpt-4')` or `anthropic('claude-3-opus-20240229')`

**Observa's Current Docs:** Shows both but doesn't clearly explain when to use which format.

**Fix Needed:**

- Explain that string format works with AI Gateway
- Explain that provider functions require provider packages
- Show examples of both formats
- Clarify which format works in which context

---

## 4. ❌ Missing: UIMessage and convertToModelMessages

**Vercel's Pattern:**

```typescript
import { UIMessage, convertToModelMessages } from "ai";

const { messages }: { messages: UIMessage[] } = await req.json();
const result = streamText({
  model: "...",
  messages: await convertToModelMessages(messages),
});
```

**Observa's Current Docs:** Doesn't mention `UIMessage` type or `convertToModelMessages()` helper.

**Fix Needed:**

- Add section explaining `UIMessage` type
- Show how to use `convertToModelMessages()` with Observa
- Explain the difference between `UIMessage` (frontend) and model messages (backend)

---

## 5. ❌ Missing: Tools/Function Calling Support

**Vercel's Pattern:**

```typescript
const result = streamText({
  model: "...",
  messages: [...],
  tools: {
    getWeather: {
      description: 'Get the weather for a location',
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => {
        // Tool implementation
      },
    },
  },
});
```

**Observa's Current Docs:** Doesn't cover tool calling at all.

**Fix Needed:**

- Add section on tool calling with Observa
- Show how tools are automatically tracked
- Explain how tool calls appear in traces
- Show example with multiple tools

---

## 6. ⚠️ Incomplete: Streaming Response Handling

**Vercel Has Two Patterns:**

1. **Next.js Route Handler (Server):**

```typescript
return result.toUIMessageStreamResponse();
```

2. **Client-Side:**

```typescript
for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}
```

**Observa's Current Docs:** Only shows client-side pattern.

**Fix Needed:**

- Add Next.js route handler example with `toUIMessageStreamResponse()`
- Show client-side example with `useChat` hook
- Explain when to use which pattern
- Show complete Next.js integration (route handler + frontend)

---

## 7. ❌ Missing: useChat Hook Integration

**Vercel's Pattern:**

```typescript
"use client";
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, sendMessage } = useChat();
  // ...
}
```

**Observa's Current Docs:** Doesn't show React hook integration.

**Fix Needed:**

- Add example showing `useChat` hook with Observa
- Show how to integrate Observa with React components
- Explain that Observa tracking works automatically with hooks

---

## 8. ⚠️ Missing: Error Handling Examples

**Vercel's Pattern:**

```typescript
try {
  const result = await streamText({...});
} catch (error) {
  // Handle errors
}
```

**Observa's Current Docs:** Mentions error handling but doesn't show examples.

**Fix Needed:**

- Add error handling examples
- Show how errors are tracked in Observa
- Explain error tracking best practices

---

## 9. ⚠️ Missing: Environment Variables Clarity

**Vercel Uses:**

- `AI_GATEWAY_API_KEY` for AI Gateway

**Observa Uses:**

- `OBSERVA_API_KEY` for Observa
- `OBSERVA_API_URL` for Observa backend

**Observa's Current Docs:** Doesn't clearly differentiate between Vercel's env vars and Observa's env vars.

**Fix Needed:**

- Clearly separate Vercel AI SDK env vars from Observa env vars
- Show complete `.env.local` example with both
- Explain which env vars are required for which features

---

## 10. ❌ Missing: Complete Next.js Integration Example

**What's Missing:** A complete, working Next.js App Router example showing:

1. Route handler setup with Observa
2. Frontend component with `useChat`
3. Environment variables
4. Provider configuration
5. Error handling

**Fix Needed:** Add a "Complete Next.js Example" section with full working code.

---

## Recommended Documentation Structure

### Updated Sections Needed:

1. **Prerequisites** ✅ (mostly correct)

   - Add: Provider package installation requirement

2. **Set Up Environment** ⚠️

   - Add: Complete `.env.local` example with both Vercel and Observa vars
   - Clarify: Which vars are for which service

3. **Next.js Route Handler Example** ❌ (NEW)

   - Complete route handler with Observa
   - Show `toUIMessageStreamResponse()` usage
   - Show `UIMessage` and `convertToModelMessages()` usage

4. **Client-Side Example** ⚠️

   - Add: `useChat` hook example
   - Show: React component integration

5. **Tools/Function Calling** ❌ (NEW)

   - Complete example with tools
   - Show how tools are tracked

6. **Model Format Guide** ⚠️

   - Explain string vs provider function format
   - Show when to use which

7. **Error Handling** ⚠️

   - Add: Error handling examples
   - Show: Error tracking in Observa

8. **Complete Next.js Example** ❌ (NEW)
   - Full working app example
   - Route handler + frontend + env vars

---

## Priority Fixes

### High Priority (Critical for Users):

1. ✅ Add Next.js route handler example with `toUIMessageStreamResponse()`
2. ✅ Add `UIMessage` and `convertToModelMessages()` usage
3. ✅ Add complete Next.js integration example
4. ✅ Clarify provider package installation

### Medium Priority (Important):

5. ✅ Add tools/function calling examples
6. ✅ Add `useChat` hook integration example
7. ✅ Improve model format explanation

### Low Priority (Nice to Have):

8. ✅ Add more error handling examples
9. ✅ Add environment variable clarification
10. ✅ Add troubleshooting section

---

## Code Examples Needed

### Example 1: Next.js Route Handler with Observa

```typescript
// app/api/chat/route.ts
import { streamText, UIMessage, convertToModelMessages } from "ai";
import { init } from "observa-sdk";
import { openai } from "@ai-sdk/openai";

const observa = init({
  apiKey: process.env.OBSERVA_API_KEY!,
  apiUrl: process.env.OBSERVA_API_URL,
});

const ai = observa.observeVercelAI(
  { streamText },
  {
    name: "my-nextjs-app",
  }
);

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = await ai.streamText({
    model: openai("gpt-4"),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
```

### Example 2: Client-Side with useChat

```typescript
// app/page.tsx
"use client";
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, sendMessage } = useChat({
    api: "/api/chat",
  });
  // ... rest of component
}
```

### Example 3: Tools/Function Calling

```typescript
const result = await ai.streamText({
  model: openai('gpt-4'),
  messages: [...],
  tools: {
    getWeather: {
      description: 'Get weather for a location',
      parameters: z.object({
        location: z.string(),
      }),
      execute: async ({ location }) => {
        // Tool implementation - automatically tracked by Observa
      },
    },
  },
});
```

---

## Summary

The Observa documentation needs significant updates to match Vercel's official patterns, especially:

- Next.js route handler integration
- `UIMessage` and `convertToModelMessages()` usage
- Tools/function calling support
- Complete working examples

These updates will ensure users can successfully integrate Observa with Vercel AI SDK following Vercel's recommended patterns.
