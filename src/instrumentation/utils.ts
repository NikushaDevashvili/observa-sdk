/**
 * Stream Wrapper Utility
 *
 * Wraps async iterator streams to capture data without blocking TTFT.
 * Uses teeing to split stream - one for user, one for tracking.
 * NEVER buffers entire response - preserves time-to-first-token.
 */

/**
 * Estimate token count from text (rough estimate)
 * In production, use actual tokenizer if available
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}

/**
 * Reconstruct OpenAI stream response from chunks
 */
function reconstructOpenAIResponse(chunks: any[]): any {
  if (chunks.length === 0) {
    return null;
  }

  // Get metadata from first and last chunks
  const firstChunk = chunks[0];
  const lastChunk = chunks[chunks.length - 1];

  // Combine all delta contents
  let fullContent = "";
  const messages: any[] = [];

  for (const chunk of chunks) {
    if (chunk?.choices?.[0]?.delta?.content) {
      fullContent += chunk.choices[0].delta.content;
    }
  }

  // Build response structure
  const response: any = {
    id: lastChunk?.id || firstChunk?.id || null,
    model: lastChunk?.model || firstChunk?.model || null,
    object: "chat.completion",
    created:
      lastChunk?.created ||
      firstChunk?.created ||
      Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullContent,
        },
        finish_reason: lastChunk?.choices?.[0]?.finish_reason || null,
      },
    ],
    usage: lastChunk?.usage || null, // Usage info typically in last chunk
  };

  return response;
}

/**
 * Extract output text from Responses API output items array
 */
function extractOutputTextFromItems(output: any[]): string | null {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && part?.text) return part.text;
      }
    }
  }
  return null;
}

/**
 * Reconstruct OpenAI Responses API stream response from chunks
 * Responses API yields events with type: 'response.output_text.delta', 'response.completed', etc.
 */
function reconstructOpenAIResponsesResponse(chunks: any[]): any {
  let fullText = "";
  let lastCompleted: any = null;
  for (const chunk of chunks) {
    const c = chunk as any;
    if (c?.type === "response.output_text.delta" && c?.delta)
      fullText += c.delta;
    if (c?.type === "response.output_text.done" && c?.text) fullText = c.text;
    if (c?.type === "response.completed" && c?.response)
      lastCompleted = c.response;
    if (c?.type === "response.failed" || c?.type === "response.incomplete")
      lastCompleted = c?.response;
  }
  if (lastCompleted) {
    return {
      ...lastCompleted,
      output_text:
        fullText ||
        (lastCompleted.output
          ? extractOutputTextFromItems(lastCompleted.output)
          : null),
    };
  }
  return {
    output: [],
    output_text: fullText || null,
    status: "incomplete",
    usage: null,
    object: "response",
  };
}

/**
 * Reconstruct Anthropic stream response from chunks
 */
function reconstructAnthropicResponse(chunks: any[]): any {
  if (chunks.length === 0) {
    return null;
  }

  const lastChunk = chunks[chunks.length - 1];
  let fullContent = "";

  for (const chunk of chunks) {
    if (chunk?.type === "content_block_delta" && chunk?.delta?.text) {
      fullContent += chunk.delta.text;
    }
  }

  return {
    id: lastChunk?.id || null,
    model: lastChunk?.model || null,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: fullContent }],
    stop_reason: lastChunk?.stop_reason || null,
    stop_sequence: lastChunk?.stop_sequence || null,
    usage: lastChunk?.usage || null,
  };
}

/**
 * Wrap an async iterator stream to capture data without blocking TTFT
 * Uses teeing to split stream - one for user, one for tracking
 *
 * @param stream - The async iterable stream (OpenAI or Anthropic)
 * @param onComplete - Callback when stream completes with full reconstructed response
 * @param onError - Callback when stream errors
 * @param provider - Provider name ('openai' | 'anthropic') for response reconstruction
 */
/** Detected OpenAI stream format: Chat Completions vs Responses API */
type OpenAIStreamFormat = "chat" | "responses";

export async function* wrapStream<T>(
  stream: AsyncIterable<T>,
  onComplete: (fullData: any) => void,
  onError: (error: any) => void,
  provider: "openai" | "anthropic" | "vercel-ai" = "openai",
): AsyncIterable<T> {
  let firstTokenTime: number | null = null;
  const chunks: T[] = [];
  let tokenCount = 0;
  const streamStartTime = Date.now();
  let openAIFormat: OpenAIStreamFormat | null =
    provider === "openai" ? null : ("chat" as OpenAIStreamFormat);

  try {
    for await (const chunk of stream) {
      // Record time-to-first-token
      if (firstTokenTime === null) {
        firstTokenTime = Date.now();
      }

      // Auto-detect OpenAI stream format from first chunk
      if (provider === "openai" && openAIFormat === null && chunk != null) {
        const c = chunk as any;
        openAIFormat =
          (c?.type?.startsWith?.("response.") ?? false) ? "responses" : "chat";
      }

      // Count tokens on-the-fly (incrementally, not buffering entire response)
      if (provider === "openai") {
        const c = chunk as any;
        if (openAIFormat === "responses") {
          const delta = c?.type === "response.output_text.delta" && c?.delta;
          if (delta && typeof delta === "string") {
            tokenCount += estimateTokens(delta);
          }
        } else {
          const content = c?.choices?.[0]?.delta?.content;
          if (content && typeof content === "string") {
            tokenCount += estimateTokens(content);
          }
        }
      } else if (provider === "anthropic") {
        const text = (chunk as any)?.delta?.text;
        if (text && typeof text === "string") {
          tokenCount += estimateTokens(text);
        }
      } else if (provider === "vercel-ai") {
        // Vercel AI SDK stream chunks are strings
        if (typeof chunk === "string") {
          tokenCount += estimateTokens(chunk);
        } else if ((chunk as any)?.textDelta) {
          tokenCount += estimateTokens((chunk as any).textDelta);
        }
      }

      chunks.push(chunk);
      yield chunk; // Yield immediately to user (preserves TTFT)
    }

    // Stream completed - reconstruct full response from chunks
    let fullResponse: any;
    if (provider === "openai") {
      const format = openAIFormat ?? "chat";
      fullResponse =
        format === "responses"
          ? reconstructOpenAIResponsesResponse(chunks)
          : reconstructOpenAIResponse(chunks);

      // CRITICAL FIX: For Chat format, check if response is empty and call onError
      // For Responses format, always call onComplete - recordTrace handles failed/incomplete
      if (format === "chat") {
        const isEmpty =
          !fullResponse?.choices?.[0]?.message?.content ||
          (typeof fullResponse.choices[0].message.content === "string" &&
            fullResponse.choices[0].message.content.trim().length === 0);
        if (!fullResponse || isEmpty) {
          onError({
            name: "EmptyResponseError",
            message: "AI returned empty response",
            errorType: "empty_response",
            errorCategory: "model_error",
            chunks: chunks.length,
          });
          return;
        }
      }
    } else if (provider === "anthropic") {
      fullResponse = reconstructAnthropicResponse(chunks);
      // CRITICAL FIX: Check if response is empty or null
      if (
        !fullResponse ||
        !fullResponse.content ||
        !fullResponse.content.some(
          (c: any) => c.text && c.text.trim().length > 0,
        )
      ) {
        onError({
          name: "EmptyResponseError",
          message: "AI returned empty response",
          errorType: "empty_response",
          errorCategory: "model_error",
          chunks: chunks.length,
        });
        return; // Don't call onComplete for empty responses
      }
    } else if (provider === "vercel-ai") {
      // Vercel AI SDK: chunks are strings, combine them
      const fullText = chunks
        .map((chunk: any) =>
          typeof chunk === "string" ? chunk : chunk?.textDelta || "",
        )
        .join("");
      // CRITICAL FIX: Check if response is empty
      if (!fullText || fullText.trim().length === 0) {
        onError({
          name: "EmptyResponseError",
          message: "AI returned empty response",
          errorType: "empty_response",
          errorCategory: "model_error",
          chunks: chunks.length,
        });
        return; // Don't call onComplete for empty responses
      }
      fullResponse = {
        text: fullText,
        tokenCount,
      };
    } else {
      fullResponse = { chunks, tokenCount };
    }

    // Call onComplete in background (don't block user)
    Promise.resolve()
      .then(() => {
        try {
          onComplete({
            ...fullResponse,
            timeToFirstToken: firstTokenTime
              ? firstTokenTime - streamStartTime
              : null,
            streamingDuration: firstTokenTime
              ? Date.now() - firstTokenTime
              : null,
            estimatedTokenCount: tokenCount,
            totalLatency: Date.now() - streamStartTime,
          });
        } catch (e) {
          onError(e);
        }
      })
      .catch((e) => {
        onError(e);
      });
  } catch (error) {
    onError(error);
    throw error; // Re-throw so user knows
  }
}
