/**
 * LangChain Callback Handler
 *
 * Implements ObservaCallbackHandler extending LangChain's BaseCallbackHandler.
 * Automatically tracks chains, LLM calls, tools, retrievers, and agents with proper hierarchy.
 * Supports metadata extraction from config, distributed tracing, and streaming.
 *
 * Follows LangFuse pattern for LangChain instrumentation.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Estimate tokens from text (rough estimate)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Extract text from LangChain message content
function extractMessageContent(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.text) return item.text;
        if (item?.content) return extractMessageContent(item.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content?.text) return content.text;
  if (content?.content) return extractMessageContent(content.content);
  return String(content || '');
}

// Convert LangChain messages to Observa message format
function convertMessages(messages: any[]): Array<{
  role: string;
  content: string | any;
}> {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg) => ({
    role: msg._getType?.() || msg.role || 'user',
    content: extractMessageContent(msg.content || msg.text || ''),
  }));
}

export interface ObserveOptions {
  name?: string;
  tags?: string[];
  userId?: string;
  sessionId?: string;
  traceId?: string | null; // Attach to existing trace (from startTrace)
  redact?: (data: any) => any;
  observa?: any; // Observa class instance
}

interface RunInfo {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  startTime: number;
  type: 'chain' | 'llm' | 'tool' | 'retriever' | 'agent';
  // LLM-specific
  model?: string;
  prompts?: string[];
  streamingTokens?: string[];
  firstTokenTime?: number;
  extraParams?: Record<string, any>;
  // Tool-specific
  toolName?: string;
  toolInput?: any;
  // Retriever-specific
  query?: string;
  documents?: any[];
  // Agent-specific
  agentAction?: any;
  // Chain-specific
  chainInputs?: any;
  chainName?: string;
}

/**
 * Observa Callback Handler for LangChain
 * Extends BaseCallbackHandler to track all LangChain operations
 */
export class ObservaCallbackHandler {
  private observa: any;
  private options: ObserveOptions;
  private runs: Map<string, RunInfo> = new Map();
  private rootRunId: string | null = null;

  constructor(observa: any, options: ObserveOptions = {}) {
    this.observa = observa;
    this.options = options;

    if (!observa) {
      console.error(
        '[Observa] ⚠️ CRITICAL ERROR: observa instance not provided!\n' +
          '\n' +
          'Tracking will NOT work. You must use observa.observeLangChain() instead.\n' +
          '\n' +
          '❌ WRONG (importing directly):\n' +
          "  import { ObservaCallbackHandler } from 'observa-sdk/instrumentation';\n" +
          '  const handler = new ObservaCallbackHandler(observa);\n' +
          '\n' +
          '✅ CORRECT (using instance method):\n' +
          "  import { init } from 'observa-sdk';\n" +
          "  const observa = init({ apiKey: '...' });\n" +
          '  const handler = observa.observeLangChain();\n'
      );
    }
  }

  // Extract metadata from config (LangFuse-compatible pattern)
  private extractMetadata(config?: any): {
    userId?: string;
    sessionId?: string;
    tags?: string[];
    traceName?: string;
  } {
    if (!config?.metadata) return {};
    return {
      userId: config.metadata.observa_user_id || this.options.userId,
      sessionId: config.metadata.observa_session_id || this.options.sessionId,
      tags: config.metadata.observa_tags
        ? [...(this.options.tags || []), ...(Array.isArray(config.metadata.observa_tags) ? config.metadata.observa_tags : [config.metadata.observa_tags])]
        : this.options.tags,
      traceName: config.runName || this.options.name,
    };
  }

  // Get trace ID for root run (use provided traceId or root run_id)
  private getTraceId(rootRunId: string): string {
    if (this.options.traceId) {
      return this.options.traceId;
    }
    return rootRunId;
  }

  // Handle chain start
  async handleChainStart(
    chain: any,
    inputs: Record<string, any>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    try {
      // Track root run
      if (!parentRunId && !this.rootRunId) {
        this.rootRunId = runId;
      }

      const parentRun = parentRunId ? this.runs.get(parentRunId) : null;
      const traceId = parentRun?.traceId || this.getTraceId(runId);

      const runInfo: RunInfo = {
        spanId: crypto.randomUUID(),
        parentSpanId: parentRun?.spanId || null,
        traceId,
        startTime: Date.now(),
        type: 'chain',
        chainInputs: inputs,
        chainName: runName || chain?.name || chain?.id || 'chain',
      };

      this.runs.set(runId, runInfo);

      // Extract metadata from config if available in extra
      const metadataFromConfig = this.extractMetadata(extra || metadata);

      // Track chain start (we'll track end separately)
      // Chain itself doesn't need a separate event, just hierarchy tracking
    } catch (error) {
      // Don't break user's code
      console.error('[Observa] Error in handleChainStart:', error);
    }
  }

  // Handle chain end
  async handleChainEnd(
    outputs: Record<string, any>,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (!runInfo || runInfo.type !== 'chain') return;

      const duration = Date.now() - runInfo.startTime;

      // Chain tracking: we track hierarchy but don't create separate events
      // The LLM/tool events within the chain are the actual tracked events
      this.runs.delete(runId);
    } catch (error) {
      console.error('[Observa] Error in handleChainEnd:', error);
    }
  }

  // Handle chain error
  async handleChainError(
    error: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (runInfo) {
        // Mark trace as having error
        this.runs.delete(runId);
      }
    } catch (err) {
      console.error('[Observa] Error in handleChainError:', err);
    }
  }

  // Handle LLM start
  async handleLLMStart(
    llm: any,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const parentRun = parentRunId ? this.runs.get(parentRunId) : null;
      if (!parentRun && !this.rootRunId) {
        this.rootRunId = runId;
      }

      const traceId = parentRun?.traceId || this.getTraceId(runId);

      // Extract model identifier
      const modelId = llm?.model || llm?.modelName || llm?.id || 'unknown';

      const runInfo: RunInfo = {
        spanId: crypto.randomUUID(),
        parentSpanId: parentRun?.spanId || null,
        traceId,
        startTime: Date.now(),
        type: 'llm',
        model: modelId,
        prompts,
        streamingTokens: [],
        extraParams: extraParams || {},
      };

      this.runs.set(runId, runInfo);
    } catch (error) {
      console.error('[Observa] Error in handleLLMStart:', error);
    }
  }

  // Handle LLM new token (streaming)
  async handleLLMNewToken(token: string, runId: string, parentRunId?: string, extraParams?: Record<string, unknown>): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (!runInfo || runInfo.type !== 'llm') return;

      // Record first token time
      if (!runInfo.firstTokenTime) {
        runInfo.firstTokenTime = Date.now();
      }

      // Aggregate streaming tokens
      if (!runInfo.streamingTokens) {
        runInfo.streamingTokens = [];
      }
      runInfo.streamingTokens.push(token);
    } catch (error) {
      console.error('[Observa] Error in handleLLMNewToken:', error);
    }
  }

  // Handle LLM end
  async handleLLMEnd(
    output: any,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (!runInfo || runInfo.type !== 'llm') return;

      const duration = Date.now() - runInfo.startTime;
      const timeToFirstToken = runInfo.firstTokenTime ? runInfo.firstTokenTime - runInfo.startTime : null;
      const streamingDuration = runInfo.firstTokenTime ? Date.now() - runInfo.firstTokenTime : null;

      // Extract output
      let outputText = '';
      let outputMessages: any[] = [];

      if (output?.generations && Array.isArray(output.generations)) {
        // Handle generations array
        const generation = output.generations[0];
        if (generation?.text) {
          outputText = generation.text;
        } else if (generation?.message) {
          outputText = extractMessageContent(generation.message.content || generation.message.text || '');
        }
        if (generation?.message) {
          outputMessages = [{ role: 'assistant', content: outputText }];
        }
      } else if (output?.text) {
        outputText = output.text;
        outputMessages = [{ role: 'assistant', content: outputText }];
      } else if (runInfo.streamingTokens && runInfo.streamingTokens.length > 0) {
        // Reconstruct from streaming tokens
        outputText = runInfo.streamingTokens.join('');
        outputMessages = [{ role: 'assistant', content: outputText }];
      }

      // Convert input prompts to messages
      const inputMessages = runInfo.prompts?.map((prompt) => ({ role: 'user', content: prompt })) || [];

      // Extract token usage
      const tokenUsage = output?.llmOutput?.tokenUsage || output?.tokenUsage || {};
      const inputTokens = tokenUsage.promptTokens || (runInfo.prompts ? runInfo.prompts.reduce((sum, p) => sum + estimateTokens(p), 0) : null);
      const outputTokens = tokenUsage.completionTokens || (outputText ? estimateTokens(outputText) : null);
      const totalTokens = tokenUsage.totalTokens || (inputTokens && outputTokens ? inputTokens + outputTokens : null);

      // Extract model from output
      const responseModel = output?.llmOutput?.modelName || output?.model || runInfo.model;

      // Extract provider from model
      let providerName = 'langchain';
      const modelLower = (runInfo.model || '').toLowerCase();
      if (modelLower.includes('gpt') || modelLower.includes('openai')) {
        providerName = 'openai';
      } else if (modelLower.includes('claude') || modelLower.includes('anthropic')) {
        providerName = 'anthropic';
      } else if (modelLower.includes('gemini') || modelLower.includes('google')) {
        providerName = 'google';
      }

      // Extract parameters from extraParams
      const extraParams = runInfo.extraParams || {};
      const temperature = extraParams.temperature || extraParams.temp || null;
      const maxTokens = extraParams.maxTokens || extraParams.max_tokens || null;
      const topP = extraParams.topP || extraParams.top_p || null;
      const topK = extraParams.topK || extraParams.top_k || null;

      // Redact if hook provided
      const sanitizedInput = this.options.redact ? this.options.redact({ prompts: runInfo.prompts, messages: inputMessages }) : { prompts: runInfo.prompts, messages: inputMessages };
      const sanitizedOutput = this.options.redact ? this.options.redact({ text: outputText, messages: outputMessages }) : { text: outputText, messages: outputMessages };

      // Track LLM call
      if (this.observa) {
        this.observa.trackLLMCall({
          model: runInfo.model || 'unknown',
          input: runInfo.prompts?.join('\n') || null,
          output: sanitizedOutput.text || outputText || null,
          inputMessages: sanitizedInput.messages || inputMessages || null,
          outputMessages: sanitizedOutput.messages || outputMessages || null,
          inputTokens,
          outputTokens,
          totalTokens,
          latencyMs: duration,
          timeToFirstTokenMs: timeToFirstToken,
          streamingDurationMs: streamingDuration,
          finishReason: output?.llmOutput?.finishReason || output?.finishReason || null,
          responseId: output?.llmOutput?.runId || runId || null,
          operationName: 'chat',
          providerName,
          responseModel,
          temperature,
          maxTokens,
          topP,
          topK,
          traceId: runInfo.traceId,
          metadata: {
            langchain_run_id: runId,
            langchain_run_name: runName || null,
            extra_params: Object.keys(extraParams).length > 0 ? extraParams : null,
          },
        });
      }

      this.runs.delete(runId);
    } catch (error) {
      console.error('[Observa] Error in handleLLMEnd:', error);
    }
  }

  // Handle LLM error
  async handleLLMError(
    error: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (runInfo) {
        // Track error but don't break user flow
        this.runs.delete(runId);
      }
    } catch (err) {
      console.error('[Observa] Error in handleLLMError:', err);
    }
  }

  // Handle tool start
  async handleToolStart(
    tool: any,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const parentRun = parentRunId ? this.runs.get(parentRunId) : null;
      const traceId = parentRun?.traceId || this.getTraceId(runId);

      const toolName = tool?.name || runName || 'tool';

      const runInfo: RunInfo = {
        spanId: crypto.randomUUID(),
        parentSpanId: parentRun?.spanId || null,
        traceId,
        startTime: Date.now(),
        type: 'tool',
        toolName,
        toolInput: input,
      };

      this.runs.set(runId, runInfo);
    } catch (error) {
      console.error('[Observa] Error in handleToolStart:', error);
    }
  }

  // Handle tool end
  async handleToolEnd(
    output: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (!runInfo || runInfo.type !== 'tool') return;

      const duration = Date.now() - runInfo.startTime;

      // Parse tool input/output
      let toolArgs: any = null;
      try {
        toolArgs = typeof runInfo.toolInput === 'string' ? JSON.parse(runInfo.toolInput) : runInfo.toolInput;
      } catch {
        toolArgs = { input: runInfo.toolInput };
      }

      let toolResult: any = null;
      try {
        toolResult = typeof output === 'string' ? JSON.parse(output) : output;
      } catch {
        toolResult = { output };
      }

      // Track tool call
      if (this.observa) {
        this.observa.trackToolCall({
          toolName: runInfo.toolName || 'tool',
          args: toolArgs,
          result: toolResult,
          resultStatus: 'success',
          latencyMs: duration,
          traceId: runInfo.traceId,
          parentSpanId: runInfo.parentSpanId,
        });
      }

      this.runs.delete(runId);
    } catch (error) {
      console.error('[Observa] Error in handleToolEnd:', error);
    }
  }

  // Handle tool error
  async handleToolError(
    error: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (runInfo && runInfo.type === 'tool') {
        const duration = Date.now() - runInfo.startTime;

        let toolArgs: any = null;
        try {
          toolArgs = typeof runInfo.toolInput === 'string' ? JSON.parse(runInfo.toolInput) : runInfo.toolInput;
        } catch {
          toolArgs = { input: runInfo.toolInput };
        }

        // Track tool error
        if (this.observa) {
          this.observa.trackToolCall({
            toolName: runInfo.toolName || 'tool',
            args: toolArgs,
            result: null,
            resultStatus: 'error',
            latencyMs: duration,
            errorMessage: error.message,
            errorType: error.name,
            errorCategory: 'tool_error',
            traceId: runInfo.traceId,
            parentSpanId: runInfo.parentSpanId,
          });
        }
      }

      if (runInfo) {
        this.runs.delete(runId);
      }
    } catch (err) {
      console.error('[Observa] Error in handleToolError:', err);
    }
  }

  // Handle retriever start
  async handleRetrieverStart(
    retriever: any,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const parentRun = parentRunId ? this.runs.get(parentRunId) : null;
      const traceId = parentRun?.traceId || this.getTraceId(runId);

      const runInfo: RunInfo = {
        spanId: crypto.randomUUID(),
        parentSpanId: parentRun?.spanId || null,
        traceId,
        startTime: Date.now(),
        type: 'retriever',
        query,
        documents: [],
      };

      this.runs.set(runId, runInfo);
    } catch (error) {
      console.error('[Observa] Error in handleRetrieverStart:', error);
    }
  }

  // Handle retriever end
  async handleRetrieverEnd(
    documents: any[],
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (!runInfo || runInfo.type !== 'retriever') return;

      const duration = Date.now() - runInfo.startTime;

      // Extract document IDs and metadata
      const contextIds: string[] = [];
      const similarityScores: number[] = [];

      for (const doc of documents || []) {
        if (doc?.metadata?.id) {
          contextIds.push(doc.metadata.id);
        } else if (doc?.id) {
          contextIds.push(doc.id);
        }
        if (doc?.metadata?.score !== undefined) {
          similarityScores.push(doc.metadata.score);
        } else if (doc?.score !== undefined) {
          similarityScores.push(doc.score);
        }
      }

      // Track retrieval
      if (this.observa) {
        this.observa.trackRetrieval({
          contextIds: contextIds.length > 0 ? contextIds : undefined,
          k: documents?.length || undefined,
          similarityScores: similarityScores.length > 0 ? similarityScores : undefined,
          latencyMs: duration,
          traceId: runInfo.traceId,
          parentSpanId: runInfo.parentSpanId,
        });
      }

      this.runs.delete(runId);
    } catch (error) {
      console.error('[Observa] Error in handleRetrieverEnd:', error);
    }
  }

  // Handle retriever error
  async handleRetrieverError(
    error: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (runInfo) {
        this.runs.delete(runId);
      }
    } catch (err) {
      console.error('[Observa] Error in handleRetrieverError:', err);
    }
  }

  // Handle agent action
  async handleAgentAction(action: any, runId: string, parentRunId?: string, tags?: string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    try {
      const parentRun = parentRunId ? this.runs.get(parentRunId) : null;
      const traceId = parentRun?.traceId || this.getTraceId(runId);

      const runInfo: RunInfo = {
        spanId: crypto.randomUUID(),
        parentSpanId: parentRun?.spanId || null,
        traceId,
        startTime: Date.now(),
        type: 'agent',
        agentAction: action,
      };

      this.runs.set(runId, runInfo);
    } catch (error) {
      console.error('[Observa] Error in handleAgentAction:', error);
    }
  }

  // Handle agent finish
  async handleAgentFinish(finish: any, runId: string, parentRunId?: string, tags?: string[], metadata?: Record<string, unknown>, runName?: string): Promise<void> {
    try {
      const runInfo = this.runs.get(runId);
      if (runInfo) {
        this.runs.delete(runId);
      }
    } catch (error) {
      console.error('[Observa] Error in handleAgentFinish:', error);
    }
  }
}

/**
 * Create Observa callback handler for LangChain
 * This is the main export function
 * 
 * Note: We don't extend BaseCallbackHandler because @langchain/core might not be installed.
 * LangChain accepts any object with the callback methods, so we just implement them.
 */
export function observeLangChain(observa: any, options?: ObserveOptions): any {
  try {
    // Create the internal handler
    const handler = new ObservaCallbackHandler(observa, options || {});

    // Return handler object with all callback methods
    // LangChain will accept this even if it doesn't extend BaseCallbackHandler
    return {
      async handleChainStart(chain: any, inputs: any, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runType?: string, runName?: string, extra?: any): Promise<void> {
        return handler.handleChainStart(chain, inputs, runId, parentRunId, tags, metadata, runType, runName, extra);
      },

      async handleChainEnd(outputs: any, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runType?: string, runName?: string, extra?: any): Promise<void> {
        return handler.handleChainEnd(outputs, runId, parentRunId, tags, metadata, runType, runName, extra);
      },

      async handleChainError(error: Error, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runType?: string, runName?: string, extra?: any): Promise<void> {
        return handler.handleChainError(error, runId, parentRunId, tags, metadata, runType, runName, extra);
      },

      async handleLLMStart(llm: any, prompts: string[], runId: string, parentRunId?: string, extraParams?: any, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleLLMStart(llm, prompts, runId, parentRunId, extraParams, tags, metadata, runName);
      },

      async handleLLMNewToken(token: string, runId: string, parentRunId?: string, extraParams?: any): Promise<void> {
        return handler.handleLLMNewToken(token, runId, parentRunId, extraParams);
      },

      async handleLLMEnd(output: any, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleLLMEnd(output, runId, parentRunId, tags, metadata, runName);
      },

      async handleLLMError(error: Error, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleLLMError(error, runId, parentRunId, tags, metadata, runName);
      },

      async handleToolStart(tool: any, input: string, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleToolStart(tool, input, runId, parentRunId, tags, metadata, runName);
      },

      async handleToolEnd(output: string, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleToolEnd(output, runId, parentRunId, tags, metadata, runName);
      },

      async handleToolError(error: Error, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleToolError(error, runId, parentRunId, tags, metadata, runName);
      },

      async handleRetrieverStart(retriever: any, query: string, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleRetrieverStart(retriever, query, runId, parentRunId, tags, metadata, runName);
      },

      async handleRetrieverEnd(documents: any[], runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleRetrieverEnd(documents, runId, parentRunId, tags, metadata, runName);
      },

      async handleRetrieverError(error: Error, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleRetrieverError(error, runId, parentRunId, tags, metadata, runName);
      },

      async handleAgentAction(action: any, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleAgentAction(action, runId, parentRunId, tags, metadata, runName);
      },

      async handleAgentFinish(finish: any, runId: string, parentRunId?: string, tags?: string[], metadata?: any, runName?: string): Promise<void> {
        return handler.handleAgentFinish(finish, runId, parentRunId, tags, metadata, runName);
      },
    };
  } catch (error) {
    console.error('[Observa] Failed to create LangChain handler:', error);
    // Return no-op handler on error
    return {
      handleChainStart: () => Promise.resolve(),
      handleChainEnd: () => Promise.resolve(),
      handleChainError: () => Promise.resolve(),
      handleLLMStart: () => Promise.resolve(),
      handleLLMNewToken: () => Promise.resolve(),
      handleLLMEnd: () => Promise.resolve(),
      handleLLMError: () => Promise.resolve(),
      handleToolStart: () => Promise.resolve(),
      handleToolEnd: () => Promise.resolve(),
      handleToolError: () => Promise.resolve(),
      handleRetrieverStart: () => Promise.resolve(),
      handleRetrieverEnd: () => Promise.resolve(),
      handleRetrieverError: () => Promise.resolve(),
      handleAgentAction: () => Promise.resolve(),
      handleAgentFinish: () => Promise.resolve(),
    };
  }
}
