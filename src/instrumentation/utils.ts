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
  let fullContent = '';
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
    object: 'chat.completion',
    created: lastChunk?.created || firstChunk?.created || Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
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
 * Reconstruct Anthropic stream response from chunks
 */
function reconstructAnthropicResponse(chunks: any[]): any {
  if (chunks.length === 0) {
    return null;
  }

  const lastChunk = chunks[chunks.length - 1];
  let fullContent = '';

  for (const chunk of chunks) {
    if (chunk?.type === 'content_block_delta' && chunk?.delta?.text) {
      fullContent += chunk.delta.text;
    }
  }

  return {
    id: lastChunk?.id || null,
    model: lastChunk?.model || null,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: fullContent }],
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
export async function* wrapStream<T>(
  stream: AsyncIterable<T>,
  onComplete: (fullData: any) => void,
  onError: (error: any) => void,
  provider: 'openai' | 'anthropic' | 'vercel-ai' = 'openai'
): AsyncIterable<T> {
  let firstTokenTime: number | null = null;
  const chunks: T[] = [];
  let tokenCount = 0;
  const streamStartTime = Date.now();

  try {
    for await (const chunk of stream) {
      // Record time-to-first-token
      if (firstTokenTime === null) {
        firstTokenTime = Date.now();
      }

      // Count tokens on-the-fly (incrementally, not buffering entire response)
      if (provider === 'openai') {
        const content = (chunk as any)?.choices?.[0]?.delta?.content;
        if (content && typeof content === 'string') {
          tokenCount += estimateTokens(content);
        }
      } else if (provider === 'anthropic') {
        const text = (chunk as any)?.delta?.text;
        if (text && typeof text === 'string') {
          tokenCount += estimateTokens(text);
        }
      } else if (provider === 'vercel-ai') {
        // Vercel AI SDK stream chunks are strings
        if (typeof chunk === 'string') {
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
    if (provider === 'openai') {
      fullResponse = reconstructOpenAIResponse(chunks);
      // CRITICAL FIX: Check if response is empty or null
      if (!fullResponse || !fullResponse.choices?.[0]?.message?.content || 
          (typeof fullResponse.choices[0].message.content === 'string' && 
           fullResponse.choices[0].message.content.trim().length === 0)) {
        onError({
          name: 'EmptyResponseError',
          message: 'AI returned empty response',
          errorType: 'empty_response',
          errorCategory: 'model_error',
          chunks: chunks.length,
        });
        return; // Don't call onComplete for empty responses
      }
    } else if (provider === 'anthropic') {
      fullResponse = reconstructAnthropicResponse(chunks);
      // CRITICAL FIX: Check if response is empty or null
      if (!fullResponse || !fullResponse.content || 
          !fullResponse.content.some((c: any) => c.text && c.text.trim().length > 0)) {
        onError({
          name: 'EmptyResponseError',
          message: 'AI returned empty response',
          errorType: 'empty_response',
          errorCategory: 'model_error',
          chunks: chunks.length,
        });
        return; // Don't call onComplete for empty responses
      }
    } else if (provider === 'vercel-ai') {
      // Vercel AI SDK: chunks are strings, combine them
      const fullText = chunks
        .map((chunk: any) => (typeof chunk === 'string' ? chunk : chunk?.textDelta || ''))
        .join('');
      // CRITICAL FIX: Check if response is empty
      if (!fullText || fullText.trim().length === 0) {
        onError({
          name: 'EmptyResponseError',
          message: 'AI returned empty response',
          errorType: 'empty_response',
          errorCategory: 'model_error',
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
