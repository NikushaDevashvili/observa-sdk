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

import {
  buildNormalizedLLMCall,
  buildOtelMetadata,
  normalizeToolDefinitions,
} from "./normalize";

// Estimate tokens from text (rough estimate)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Extract model name from LangChain LLM object (avoid using llm.id which is class path)
function extractModelName(llm: any): string {
  if (!llm) return 'unknown';

  const candidates = [
    llm.modelName,
    llm.model,
    llm.modelId,
    llm.model_id,
    llm.model_name,
    llm.llm?.modelName,
    llm.client?.config?.model,
    llm.client?.config?.modelName,
    llm.invocationParams?.model,
    llm.invocationParams?.modelName,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  // Do NOT use llm.id - it contains class path like "langchain,chat_models,openai,ChatOpenAI"
  return 'unknown';
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

// Safely serialize values for debug metadata (avoid circular refs)
function safeSerialize(value: any, maxLength = 5000): string | null {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[circular]';
          seen.add(val);
        }
        return val;
      }
    );
    if (!json) return null;
    return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
  } catch {
    try {
      return String(value).slice(0, maxLength);
    } catch {
      return null;
    }
  }
}


// Normalize tool arguments string - handles malformed JSON strings
// This is a shared utility that matches the logic in index.ts normalizeToolArguments
function normalizeToolArgumentsString(value: string): any {
  // #region agent log
  fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      location: "langchain.ts:normalizeToolArgumentsString:entry",
      message: "normalizeToolArgumentsString called (langchain)",
      data: {
        valuePreview: value.substring(0, 200),
        valueLength: value.length,
        startsWithDoubleQuote: value.trim().startsWith('""'),
        endsWithDoubleQuote: value.trim().endsWith('""'),
      },
      timestamp: Date.now(),
      sessionId: "debug-session",
      runId: "run1",
      hypothesisId: "A,B,D",
    }),
  }).catch(() => {});
  // #endregion
  
  // If empty string, return as-is
  if (value.trim().length === 0) {
    return value;
  }
  
  const trimmed = value.trim();
  
  // Following Langfuse's approach: only parse if it looks like valid JSON
  // Check if it starts with { or [ (valid JSON object/array)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      // Try to parse as JSON first
      const parsed = JSON.parse(value);
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "langchain.ts:normalizeToolArgumentsString:parsed",
        message: "Successfully parsed as JSON (langchain)",
        data: { parsedType: typeof parsed },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "A",
      }),
    }).catch(() => {});
    // #endregion
      return parsed;
    } catch (parseError) {
      // If it looks like JSON but fails to parse, log warning and return as-is
      // Following Langfuse's approach: don't try to fix, just pass through
      // #region agent log
      fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "langchain.ts:normalizeToolArgumentsString:parseFailedButLooksLikeJSON",
          message: "WARNING: Looks like JSON but failed to parse - returning as-is (following Langfuse approach)",
          data: {
            error: String(parseError),
            valuePreview: value.substring(0, 200),
          },
          timestamp: Date.now(),
          sessionId: "debug-session",
          runId: "run1",
          hypothesisId: "A",
        }),
      }).catch(() => {});
      // #endregion
      console.warn('[Observa] Failed to parse arguments JSON string (looks like JSON but invalid):', trimmed.substring(0, 100));
      return value; // Return as-is to avoid breaking
    }
  }
  
  // If it doesn't look like valid JSON, check if it's the malformed pattern
  // Pattern: "key":"value" (missing outer braces) - this is the problematic case
  if (
    trimmed.startsWith('"') &&
    !trimmed.startsWith('"{') &&
    trimmed.includes(':') &&
    trimmed.length > 3
  ) {
    // This is the malformed pattern that causes "arguments":""query":"value"" in final JSON
    // We need to fix it by wrapping in braces
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "langchain.ts:normalizeToolArgumentsString:malformedPattern",
        message: "Detected malformed pattern - attempting fix",
        data: {
          valuePreview: trimmed.substring(0, 200),
        },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion
    
    // Handle case where string is double-quoted (e.g., ""key":"value"")
    // This can happen when LangChain provides arguments that are incorrectly encoded
    if (trimmed.startsWith('""') && trimmed.endsWith('""')) {
      // Remove outer double quotes and try parsing the inner content
      const inner = trimmed.slice(1, -1);
      try {
        return JSON.parse(inner);
      } catch {
        // If inner still fails, it might be a JSON object missing braces
        // Try wrapping in braces: "key":"value" -> {"key":"value"}
        if (inner.includes(':') && !inner.startsWith('{') && !inner.startsWith('[')) {
          try {
            return JSON.parse(`{${inner}}`);
          } catch {
            // If that also fails, try to fix common issues:
            // 1. The inner might be "key":"value" which needs braces
            // 2. Check if it's a valid JSON object structure
            if (inner.match(/^"[^"]+":/)) {
              // It looks like "key":... so try wrapping
              try {
                return JSON.parse(`{${inner}}`);
              } catch {
                // Last resort: return the original value
              }
            }
          }
        }
      }
    }
    
    // Handle case where string looks like a JSON object property but missing outer braces
    // Most common pattern: "query":"value" -> should be {"query":"value"}
    // CRITICAL: This pattern causes "arguments":""query":"value"" in final JSON
    // Try a simple approach: if it starts with " and has :, try wrapping in {}
    if (trimmed.startsWith('"') && !trimmed.startsWith('"{') && trimmed.includes(':')) {
      // #region agent log
      fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "langchain.ts:normalizeToolArgumentsString:attemptSimpleWrap",
          message: "Attempting simple wrap for malformed JSON pattern",
          data: {
            trimmed: trimmed.substring(0, 200),
            trimmedLength: trimmed.length,
            firstChar: trimmed[0],
            hasColon: trimmed.includes(':'),
            wrapped: `{${trimmed}}`.substring(0, 200),
          },
          timestamp: Date.now(),
          sessionId: "debug-session",
          runId: "run1",
          hypothesisId: "B",
        }),
      }).catch(() => {});
      // #endregion
      
      // Try wrapping the entire string in braces
      try {
        const wrapped = `{${trimmed}}`;
        const parsed = JSON.parse(wrapped);
        // #region agent log
        fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "langchain.ts:normalizeToolArgumentsString:simpleWrapSuccess",
            message: "Successfully fixed by simple wrapping",
            data: {
              original: trimmed.substring(0, 100),
              wrapped: wrapped.substring(0, 100),
              parsedType: typeof parsed,
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "B",
          }),
        }).catch(() => {});
        // #endregion
        return parsed;
      } catch (wrapError) {
        // #region agent log
        fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "langchain.ts:normalizeToolArgumentsString:simpleWrapFailed",
            message: "Simple wrapping failed - this will cause JSON error",
            data: {
              error: String(wrapError),
              errorMessage: wrapError instanceof Error ? wrapError.message : String(wrapError),
              trimmed: trimmed.substring(0, 200),
              wrapped: `{${trimmed}}`.substring(0, 200),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "B",
          }),
        }).catch(() => {});
        // #endregion
        
        // If simple wrapping fails, try one more aggressive fix:
        // The string might be "key":"value" but with escaped quotes or special characters
        // Try to extract the key and value manually and reconstruct
        try {
          // More robust regex that handles quoted values with special characters
          // Pattern: "key":"value" where value can contain escaped quotes, colons, etc.
          const keyMatch = trimmed.match(/^"([^"]+)":\s*/);
          if (keyMatch && keyMatch[1]) {
            const key: string = keyMatch[1];
            const afterKey = trimmed.substring(keyMatch[0].length);
            
            let val: any = '';
            // Try to parse the value
            if (afterKey.startsWith('"')) {
              // Value is a quoted string - find the closing quote (handling escaped quotes)
              let endQuoteIndex = -1;
              let i = 1;
              while (i < afterKey.length) {
                if (afterKey[i] === '"' && afterKey[i - 1] !== '\\') {
                  endQuoteIndex = i;
                  break;
                }
                i++;
              }
              if (endQuoteIndex > 0) {
                val = afterKey.substring(1, endQuoteIndex);
                // Unescape the value
                val = val.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
              } else {
                // No closing quote found, take the rest
                val = afterKey.substring(1);
              }
            } else {
              // Value is not quoted - try to parse as JSON (number, boolean, null, etc.)
              try {
                val = JSON.parse(afterKey.trim());
              } catch {
                // If parsing fails, take the rest as string
                val = afterKey.trim();
              }
            }
            
            const reconstructed: Record<string, any> = { [key]: val };
            // #region agent log
            fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "langchain.ts:normalizeToolArgumentsString:reconstructSuccess",
                message: "Successfully reconstructed from key-value pattern",
                data: {
                  original: trimmed.substring(0, 100),
                  reconstructed: JSON.stringify(reconstructed).substring(0, 100),
                  key,
                  valuePreview: String(val).substring(0, 50),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "B",
              }),
            }).catch(() => {});
            // #endregion
            return reconstructed;
          }
        } catch (reconstructError) {
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeToolArgumentsString:reconstructFailed",
              message: "Reconstruction failed",
              data: {
                error: String(reconstructError),
                trimmed: trimmed.substring(0, 200),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }).catch(() => {});
          // #endregion
        }
        
        // If all fixes fail, the string is likely malformed in a way we can't fix
        // Return as-is - it will be escaped by JSON.stringify but may still cause issues
        // Log a warning that this might cause problems
        console.warn('[Observa] Failed to normalize malformed arguments string:', trimmed.substring(0, 100));
      }
    }
    
    // Handle case where string looks like a JSON object property but missing outer braces
    // Example: "query":"value" (should be {"query":"value"})
    // This is a fallback check for cases that didn't match the simple wrap above
    if (
      trimmed.includes(':') &&
      !trimmed.startsWith('{') &&
      !trimmed.startsWith('[') &&
      trimmed.startsWith('"')
    ) {
      // #region agent log
      fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: "langchain.ts:normalizeToolArgumentsString:attemptWrap",
          message: "Attempting to wrap string in braces",
          data: {
            trimmed: trimmed.substring(0, 200),
            matchesPattern: !!trimmed.match(/^"[^"]+":/),
            wrapped: `{${trimmed}}`.substring(0, 200),
          },
          timestamp: Date.now(),
          sessionId: "debug-session",
          runId: "run1",
          hypothesisId: "B",
        }),
      }).catch(() => {});
      // #endregion
      
      // Check if it matches the pattern "key": (with optional value)
      const keyPattern = /^"[^"]+":/;
      if (keyPattern.test(trimmed)) {
        try {
          // Try wrapping in braces
          const wrapped = `{${trimmed}}`;
          const parsed = JSON.parse(wrapped);
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeToolArgumentsString:wrapSuccess",
              message: "Successfully wrapped and parsed",
              data: { parsedType: typeof parsed },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }).catch(() => {});
          // #endregion
          return parsed;
        } catch (wrapError) {
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeToolArgumentsString:wrapFailed",
              message: "Wrapping in braces failed",
              data: { error: String(wrapError), wrapped: `{${trimmed}}`.substring(0, 200) },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }).catch(() => {});
          // #endregion
          // Fall through - return original value
        }
      }
    }
    
    // If all parsing attempts fail, return the value as-is
    // JSON.stringify will properly escape it
    // #region agent log
    fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "langchain.ts:normalizeToolArgumentsString:returnOriginal",
        message: "Returning original value (langchain, all fixes failed)",
        data: { valuePreview: value.substring(0, 200) },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "B",
      }),
    }).catch(() => {});
    // #endregion
    
    // If we get here, all fixes failed
    // CRITICAL: If the value looks like malformed JSON (starts with quote and has colon),
    // we MUST fix it or it will cause JSON parsing errors downstream
    // Last resort: try to extract key-value and reconstruct
    if (trimmed.startsWith('"') && trimmed.includes(':') && !trimmed.startsWith('"{')) {
      const keyValueMatch = trimmed.match(/^"([^"]+)"\s*:\s*(.+)$/);
      if (keyValueMatch && keyValueMatch[1]) {
        const key: string = keyValueMatch[1];
        let val: any = keyValueMatch[2] || '';
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        try {
          const reconstructed = { [key]: val };
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeToolArgumentsString:lastResortFix",
              message: "Last resort fix succeeded",
              data: { key, valuePreview: typeof val === 'string' ? val.substring(0, 100) : val },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "LAST_RESORT",
            }),
          }).catch(() => {});
          // #endregion
          return reconstructed;
        } catch {
          // If even this fails, return empty object to prevent JSON errors
          return {};
        }
      }
    }
    
    // If it doesn't match the pattern, return as-is (might be a plain string)
    return value;
  }
}

// Normalize additional_kwargs: parse nested JSON strings (like function_call.arguments)
// to avoid double-encoding when the whole object is later JSON.stringify'd
function normalizeAdditionalKwargs(kwargs: any): Record<string, any> | null {
  if (!kwargs || typeof kwargs !== 'object') return null;
  
  try {
    const result: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(kwargs)) {
      if (key === 'function_call' && value && typeof value === 'object') {
        // Handle function_call.arguments - parse if it's a JSON string
        const fc = value as Record<string, any>;
        const normalizedFc: Record<string, any> = { ...fc };
        
        if (typeof fc.arguments === 'string') {
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeAdditionalKwargs:function_call.arguments",
              message: "Found string arguments in function_call",
              data: {
                argsValue: fc.arguments.substring(0, 200),
                argsLength: fc.arguments.length,
                startsWithQuote: fc.arguments.trim().startsWith('"'),
                hasColon: fc.arguments.includes(':'),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }).catch(() => {});
          // #endregion
          const normalized = normalizeToolArgumentsString(fc.arguments);
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeAdditionalKwargs:function_call.arguments:after",
              message: "After normalization",
              data: {
                normalizedType: typeof normalized,
                normalizedPreview: typeof normalized === "string" ? normalized.substring(0, 200) : JSON.stringify(normalized).substring(0, 200),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }).catch(() => {});
          // #endregion
          normalizedFc.arguments = normalized;
        } else if (fc.arguments !== undefined) {
          // #region agent log
          fetch("http://127.0.0.1:7243/ingest/58308b77-6db1-45c3-a89e-548ba2d1edd2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "langchain.ts:normalizeAdditionalKwargs:function_call.arguments:nonString",
              message: "Arguments is not a string",
              data: {
                argsType: typeof fc.arguments,
                argsPreview: JSON.stringify(fc.arguments).substring(0, 200),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }).catch(() => {});
          // #endregion
        }
        result[key] = normalizedFc;
      } else if (key === 'tool_calls' && Array.isArray(value)) {
        // Handle tool_calls array - each may have function.arguments as JSON string
        result[key] = value.map((tc: any) => {
          if (!tc || typeof tc !== 'object') return tc;
          const normalized = { ...tc };
          if (tc.function && typeof tc.function === 'object') {
            const fn = { ...tc.function };
            if (typeof fn.arguments === 'string') {
              fn.arguments = normalizeToolArgumentsString(fn.arguments);
            }
            normalized.function = fn;
          }
          return normalized;
        });
      } else {
        result[key] = value;
      }
    }
    
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// Convert LangChain messages to Observa message format
function convertMessages(messages: any[]): Array<{
  role: string;
  content: string;
  // Store kwargs as normalized object (not string) for proper JSON serialization
  additional_kwargs?: Record<string, any> | null;
}> {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg) => {
    const baseKwargs =
      msg?.additional_kwargs ||
      msg?.kwargs?.additional_kwargs ||
      null;
    const mergedKwargs: Record<string, any> =
      baseKwargs && typeof baseKwargs === 'object' ? { ...baseKwargs } : {};

    if (!mergedKwargs.function_call && msg?.kwargs?.function_call) {
      mergedKwargs.function_call = msg.kwargs.function_call;
    }
    if (!mergedKwargs.tool_calls && msg?.kwargs?.tool_calls) {
      mergedKwargs.tool_calls = msg.kwargs.tool_calls;
    }
    if (!mergedKwargs.function_call && msg?.function_call) {
      mergedKwargs.function_call = msg.function_call;
    }
    if (!mergedKwargs.tool_calls && msg?.tool_calls) {
      mergedKwargs.tool_calls = msg.tool_calls;
    }

    return {
      role: msg._getType?.() || msg.role || 'user',
      content: extractMessageContent(msg.content || msg.text || ''),
      additional_kwargs: normalizeAdditionalKwargs(
        Object.keys(mergedKwargs).length > 0 ? mergedKwargs : null
      ),
    };
  });
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
  inputMessages?: Array<{
    role: string;
    content: any;
    additional_kwargs?: any;
  }>;
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
    const tags = config.metadata.observa_tags
      ? [
          ...(this.options.tags || []),
          ...(Array.isArray(config.metadata.observa_tags)
            ? config.metadata.observa_tags
            : [config.metadata.observa_tags]),
        ]
      : this.options.tags;

    const result: {
      userId?: string;
      sessionId?: string;
      tags?: string[];
      traceName?: string;
    } = {
      userId: config.metadata.observa_user_id || this.options.userId,
      sessionId: config.metadata.observa_session_id || this.options.sessionId,
      traceName: config.runName || this.options.name,
    };

    if (tags && tags.length > 0) {
      result.tags = tags;
    }

    return result;
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

      // Extract model identifier properly (avoid llm.id which is class path)
      let modelStr = extractModelName(llm);
      try {
        const invocationParams = (extraParams as any)?.invocation_params;
        const paramsModel =
          invocationParams?.model ||
          invocationParams?.model_name ||
          invocationParams?.modelName;
        const metaModel =
          metadata && typeof (metadata as any).ls_model_name === 'string'
            ? (metadata as any).ls_model_name
            : null;
        if (typeof paramsModel === 'string' && paramsModel.trim().length > 0) {
          modelStr = paramsModel;
        } else if (typeof metaModel === 'string' && metaModel.trim().length > 0) {
          modelStr = metaModel;
        }
      } catch {
        // Keep default modelStr if extraction fails
      }

      const runInfo: RunInfo = {
        spanId: crypto.randomUUID(),
        parentSpanId: parentRun?.spanId || null,
        traceId,
        startTime: Date.now(),
        type: 'llm',
        model: modelStr,
        prompts,
        streamingTokens: [],
        extraParams: extraParams || {},
      };

      this.runs.set(runId, runInfo);
    } catch (error) {
      console.error('[Observa] Error in handleLLMStart:', error);
    }
  }

  // Handle ChatModel start (LangChain chat models use BaseMessage[][])
  async handleChatModelStart(
    llm: any,
    messages: any[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    try {
      const flatMessages = Array.isArray(messages)
        ? messages.flatMap((group) => (Array.isArray(group) ? group : []))
        : [];
      const inputMessages = convertMessages(flatMessages);
      const prompts = inputMessages.map((msg) =>
        extractMessageContent(msg.content || '')
      );

      await this.handleLLMStart(
        llm,
        prompts,
        runId,
        parentRunId,
        extraParams,
        tags,
        metadata,
        runName
      );

      const runInfo = this.runs.get(runId);
      if (runInfo && runInfo.type === 'llm') {
        runInfo.inputMessages = inputMessages;
      }
    } catch (error) {
      console.error('[Observa] Error in handleChatModelStart:', error);
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

      // Extract output (defensive - handle multiple LangChain output formats)
      let outputText = '';
      let outputMessages: any[] = [];
      const lastGeneration = (() => {
        if (!output?.generations || !Array.isArray(output.generations) || output.generations.length === 0) {
          return null;
        }
        const lastGroup = output.generations[output.generations.length - 1];
        if (Array.isArray(lastGroup) && lastGroup.length > 0) {
          return lastGroup[lastGroup.length - 1];
        }
        return lastGroup || null;
      })();

      try {
        // Handle generations array (standard LangChain format)
        if (output?.generations && Array.isArray(output.generations) && output.generations.length > 0) {
          const first = output.generations[0];
          const generation = Array.isArray(first) ? first[0] : first;

          if (generation?.text) {
            outputText = generation.text;
            outputMessages = [{ role: 'assistant', content: outputText }];
          } else if (generation?.message) {
            outputText = extractMessageContent(generation.message.content || generation.message.text || '');
            outputMessages = [{ role: 'assistant', content: outputText }];
          }
        }
        // Handle last generation (Langfuse-style)
        if (!outputText && lastGeneration) {
          if (lastGeneration?.message) {
            outputText = extractMessageContent(
              lastGeneration.message.content || lastGeneration.message.text || ''
            );
            outputMessages = convertMessages([lastGeneration.message]);
          } else if (lastGeneration?.text) {
            outputText = lastGeneration.text;
            outputMessages = [{ role: 'assistant', content: outputText }];
          }
        }
        // Handle direct text property
        else if (output?.text && typeof output.text === 'string') {
          outputText = output.text;
          outputMessages = [{ role: 'assistant', content: outputText }];
        }
        // Handle message content directly
        else if (output?.content) {
          outputText = extractMessageContent(output.content);
          outputMessages = [{ role: 'assistant', content: outputText }];
        }
        // Handle chat model output (AIMessage or similar)
        else if (output && typeof output === 'object') {
          // Try to extract from message-like objects
          if (output.text) {
            outputText = extractMessageContent(output.text);
          } else if (output.content) {
            outputText = extractMessageContent(output.content);
          } else if (output.message?.content) {
            outputText = extractMessageContent(output.message.content);
          }
          if (outputText) {
            outputMessages = [{ role: 'assistant', content: outputText }];
          }
        }
        // Fallback: reconstruct from streaming tokens if available
        if (!outputText && runInfo.streamingTokens && runInfo.streamingTokens.length > 0) {
          outputText = runInfo.streamingTokens.join('');
          outputMessages = [{ role: 'assistant', content: outputText }];
        }
      } catch (err) {
        // If output extraction fails, try streaming tokens
        if (runInfo.streamingTokens && runInfo.streamingTokens.length > 0) {
          outputText = runInfo.streamingTokens.join('');
          outputMessages = [{ role: 'assistant', content: outputText }];
        }
      }

      // Convert input prompts to messages
      const inputMessages =
        runInfo.inputMessages ||
        runInfo.prompts?.map((prompt) => ({ role: 'user', content: prompt })) ||
        [];

      // Extract token usage (prefer AIMessage usage_metadata if available)
      const usageMetadata = lastGeneration?.message?.usage_metadata;
      const tokenUsage = output?.llmOutput?.tokenUsage || output?.tokenUsage || {};
      const inputTokens =
        usageMetadata?.input_tokens ||
        tokenUsage.promptTokens ||
        (runInfo.prompts ? runInfo.prompts.reduce((sum, p) => sum + estimateTokens(p), 0) : null);
      const outputTokens =
        usageMetadata?.output_tokens ||
        tokenUsage.completionTokens ||
        (outputText ? estimateTokens(outputText) : null);
      const totalTokens =
        usageMetadata?.total_tokens ||
        tokenUsage.totalTokens ||
        (inputTokens && outputTokens ? inputTokens + outputTokens : null);

      // Extract model from output - ensure it's a string (defensive)
      let responseModel: string | null = null;
      try {
        const responseModelRaw =
          lastGeneration?.message?.response_metadata?.model_name ||
          output?.llmOutput?.modelName ||
          output?.model ||
          runInfo.model;
        responseModel = responseModelRaw ? String(responseModelRaw) : (runInfo.model ? String(runInfo.model) : null);
      } catch (err) {
        // Fallback if model extraction fails
        try {
          responseModel = runInfo.model ? String(runInfo.model) : null;
        } catch {
          responseModel = null;
        }
      }

      // Extract provider from model (defensive - wrap in try-catch)
      let providerName = 'langchain';
      try {
        // Convert model to string safely (model might be an object or other type)
        const modelStr = runInfo.model ? String(runInfo.model) : '';
        const modelLower = modelStr.toLowerCase();
        if (modelLower.includes('gpt') || modelLower.includes('openai')) {
          providerName = 'openai';
        } else if (modelLower.includes('claude') || modelLower.includes('anthropic')) {
          providerName = 'anthropic';
        } else if (modelLower.includes('gemini') || modelLower.includes('google')) {
          providerName = 'google';
        }
      } catch (err) {
        // If provider extraction fails, use default 'langchain'
        providerName = 'langchain';
      }

      // Extract parameters from extraParams (defensive)
      let temperature: number | null = null;
      let maxTokens: number | null = null;
      let topP: number | null = null;
      let topK: number | null = null;
      let toolDefinitions: Array<Record<string, any>> | null = null;
      try {
        const extraParams = runInfo.extraParams || {};
        temperature = extraParams.temperature || extraParams.temp || null;
        maxTokens = extraParams.maxTokens || extraParams.max_tokens || null;
        topP = extraParams.topP || extraParams.top_p || null;
        topK = extraParams.topK || extraParams.top_k || null;
        toolDefinitions = normalizeToolDefinitions(extraParams.tools);
      } catch (err) {
        // If parameter extraction fails, use null values (graceful degradation)
      }

      // Redact if hook provided (defensive - don't fail if redact throws)
      let sanitizedInput: any = { prompts: runInfo.prompts, messages: inputMessages };
      let sanitizedOutput: any = { text: outputText, messages: outputMessages };
      try {
        if (this.options.redact) {
          sanitizedInput = this.options.redact({ prompts: runInfo.prompts, messages: inputMessages }) || sanitizedInput;
          sanitizedOutput = this.options.redact({ text: outputText, messages: outputMessages }) || sanitizedOutput;
        }
      } catch (err) {
        // If redaction fails, use original data (don't block tracking)
        console.warn('[Observa] Redaction hook failed, using original data:', err);
      }

      // Track LLM call (always attempt, even if extraction had errors)
      if (this.observa) {
        try {
          // Ensure model is always a string (defensive)
          let modelForTracking = 'unknown';
          try {
            modelForTracking = runInfo.model ? String(runInfo.model) : 'unknown';
          } catch (err) {
            modelForTracking = 'unknown';
          }

          const normalized = buildNormalizedLLMCall({
            request: {
              messages: sanitizedInput?.messages || inputMessages,
              model: modelForTracking,
              tools: runInfo.extraParams?.tools,
            },
            response: {
              messages: sanitizedOutput?.messages || outputMessages,
              model: responseModel,
            },
            provider: providerName,
            usage: {
              inputTokens,
              outputTokens,
              totalTokens,
            },
            toolDefsOverride: runInfo.extraParams?.tools,
          });
          const otelMetadata = buildOtelMetadata(normalized);

          // Always try to track, even with partial data
          this.observa.trackLLMCall({
            model: modelForTracking,
            input: runInfo.prompts?.join('\n') || null,
            output: sanitizedOutput?.text || outputText || null,
            inputMessages: normalized.inputMessages || sanitizedInput?.messages || inputMessages || null,
            outputMessages: normalized.outputMessages || sanitizedOutput?.messages || outputMessages || null,
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
            toolDefinitions: normalized.toolDefinitions ?? toolDefinitions,
            traceId: runInfo.traceId,
            metadata: (() => {
              // Sanitize metadata to avoid circular references
              const safeMetadata: Record<string, any> = {
                langchain_run_id: runId,
                langchain_run_name: runName || null,
                // Temporary debug payload to inspect LangChain output shape
                langchain_debug_output_shape: output
                  ? Object.keys(output).slice(0, 20)
                  : null,
                langchain_debug_output_raw: safeSerialize(output),
              };
              
              // Safely serialize extraParams (avoid circular references)
              try {
                if (runInfo.extraParams && Object.keys(runInfo.extraParams).length > 0) {
                  // Only include primitive values to avoid circular refs
                  const safeParams: Record<string, any> = {};
                  for (const [key, value] of Object.entries(runInfo.extraParams)) {
                    if (value === null || value === undefined) {
                      safeParams[key] = value;
                    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                      safeParams[key] = value;
                    } else if (Array.isArray(value)) {
                      safeParams[key] = value.map(v => typeof v === 'object' ? '[object]' : v);
                    } else if (typeof value === 'object') {
                      // Skip objects to avoid circular refs
                      safeParams[key] = '[object]';
                    }
                  }
                  if (Object.keys(safeParams).length > 0) {
                    safeMetadata.extra_params = safeParams;
                  }
                }
              } catch (err) {
                // If metadata serialization fails, skip it
              }
              
              return {
                ...safeMetadata,
                ...otelMetadata,
              };
            })(),
          });
        } catch (trackError) {
          // If tracking fails, log but don't throw (we've already extracted what we can)
          console.error('[Observa] Error tracking LLM call in handleLLMEnd:', trackError);
        }
      }

      this.runs.delete(runId);
    } catch (error) {
      // Last resort - try to track with minimal data if everything else failed
      console.error('[Observa] Error in handleLLMEnd:', error);
      
      try {
        const runInfo = this.runs.get(runId);
        if (runInfo && runInfo.type === 'llm' && this.observa) {
          const duration = Date.now() - runInfo.startTime;
          const toolDefinitions = normalizeToolDefinitions(
            runInfo.extraParams?.tools
          );
          const normalized = buildNormalizedLLMCall({
            request: {
              messages: runInfo.inputMessages || null,
              model: 'unknown',
              tools: runInfo.extraParams?.tools,
            },
            provider: 'langchain',
            toolDefsOverride: runInfo.extraParams?.tools,
          });
          const otelMetadata = buildOtelMetadata(normalized);
          // Try to track with minimal data as fallback
          this.observa.trackLLMCall({
            model: 'unknown',
            input: null,
            output: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            latencyMs: duration,
            traceId: runInfo.traceId || null,
            toolDefinitions: normalized.toolDefinitions ?? toolDefinitions,
            metadata: {
              langchain_error: true,
              error_message: error instanceof Error ? error.message : String(error),
              langchain_run_id: runId,
              ...otelMetadata,
            },
          });
        }
      } catch (fallbackError) {
        // If even fallback tracking fails, just log (don't break user's code)
        console.error('[Observa] Fallback tracking also failed in handleLLMEnd:', fallbackError);
      }
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
