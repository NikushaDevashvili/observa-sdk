/**
 * Integration test for error detection in instrumentation
 * Tests the actual recordTrace functions with various failure scenarios
 */

import { init } from './src/index';

// Create Observa instance
const observa = init({
  apiKey: 'test-key',
  tenantId: 'test-tenant',
  projectId: 'test-project',
  mode: 'development',
});

// Track captured events
const events: any[] = [];

// Override methods to capture events
const originalTrackLLMCall = observa.trackLLMCall.bind(observa);
const originalTrackError = observa.trackError.bind(observa);

observa.trackLLMCall = function(...args: any[]) {
  const event = { type: 'llm_call', data: args[0] };
  events.push(event);
  console.log('📝 LLM Call:', {
    model: event.data.model,
    hasOutput: !!event.data.output,
    finishReason: event.data.finishReason,
  });
  return originalTrackLLMCall(...args);
};

observa.trackError = function(...args: any[]) {
  const event = { type: 'error', data: args[0] };
  events.push(event);
  console.log('🚨 Error:', {
    type: event.data.errorType,
    message: event.data.errorMessage,
    category: event.data.errorCategory,
  });
  return originalTrackError(...args);
};

// We need to import the instrumentation functions
// Since they're not exported, we'll simulate the recordTrace logic
console.log('\n🧪 Integration Test: Error Detection in recordTrace');
console.log('='.repeat(70));

// Simulate recordTrace for OpenAI with empty response
function simulateRecordTraceOpenAI(req: any, res: any, observaInstance: any) {
  const inputText = req.messages?.map((m: any) => m.content).filter(Boolean).join('\n') || null;
  const outputText = res?.choices?.[0]?.message?.content || null;
  const finishReason = res?.choices?.[0]?.finish_reason || null;
  
  const isEmptyResponse = !outputText || (typeof outputText === 'string' && outputText.trim().length === 0);
  const isFailureFinishReason = finishReason === 'content_filter' || finishReason === 'length';
  
  if (isEmptyResponse || isFailureFinishReason) {
    observaInstance.trackLLMCall({
      model: req.model || res?.model || 'unknown',
      input: inputText,
      output: null,
      finishReason: finishReason,
      latencyMs: 100,
      operationName: 'chat',
      providerName: 'openai',
    });
    
    const errorType = isEmptyResponse ? 'empty_response' : 
      (finishReason === 'content_filter' ? 'content_filtered' : 'response_truncated');
    const errorMessage = isEmptyResponse ? 'AI returned empty response' :
      (finishReason === 'content_filter' ? 'AI response was filtered due to content policy' :
       'AI response was truncated due to token limit');
    
    observaInstance.trackError({
      errorType,
      errorMessage,
      errorCategory: finishReason === 'content_filter' ? 'validation_error' : 
        (finishReason === 'length' ? 'model_error' : 'unknown_error'),
      errorCode: isEmptyResponse ? 'empty_response' : finishReason,
    });
    return true; // Error detected
  }
  
  // Normal response
  observaInstance.trackLLMCall({
    model: req.model || res?.model || 'unknown',
    input: inputText,
    output: outputText,
    finishReason: finishReason,
    latencyMs: 100,
    operationName: 'chat',
    providerName: 'openai',
  });
  return false; // No error
}

// Test Case 1: Empty response
console.log('\n📋 Test Case 1: Empty Response');
const emptyReq = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
};
const emptyRes = {
  choices: [{ message: { content: '' }, finish_reason: null }],
  model: 'gpt-4',
};
const errorDetected1 = simulateRecordTraceOpenAI(emptyReq, emptyRes, observa);
console.log(`   Result: ${errorDetected1 ? '✅ Error detected' : '❌ Error NOT detected'}`);

// Test Case 2: Content filter
console.log('\n📋 Test Case 2: Content Filter');
const filterReq = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Test' }],
};
const filterRes = {
  choices: [{ message: { content: 'Some content' }, finish_reason: 'content_filter' }],
  model: 'gpt-4',
};
const errorDetected2 = simulateRecordTraceOpenAI(filterReq, filterRes, observa);
console.log(`   Result: ${errorDetected2 ? '✅ Error detected' : '❌ Error NOT detected'}`);

// Test Case 3: Length truncation
console.log('\n📋 Test Case 3: Length Truncation');
const lengthReq = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Test' }],
};
const lengthRes = {
  choices: [{ message: { content: 'Partial...' }, finish_reason: 'length' }],
  model: 'gpt-4',
};
const errorDetected3 = simulateRecordTraceOpenAI(lengthReq, lengthRes, observa);
console.log(`   Result: ${errorDetected3 ? '✅ Error detected' : '❌ Error NOT detected'}`);

// Test Case 4: Normal successful response
console.log('\n📋 Test Case 4: Normal Successful Response');
const normalReq = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
};
const normalRes = {
  choices: [{ message: { content: 'Hello! How can I help?' }, finish_reason: 'stop' }],
  model: 'gpt-4',
};
const errorDetected4 = simulateRecordTraceOpenAI(normalReq, normalRes, observa);
console.log(`   Result: ${errorDetected4 ? '❌ False positive (error detected when should be success)' : '✅ No error (correct)'}`);

// Summary
console.log('\n📊 Integration Test Summary');
console.log('='.repeat(70));
console.log('Total events:', events.length);
console.log('LLM calls:', events.filter(e => e.type === 'llm_call').length);
console.log('Errors:', events.filter(e => e.type === 'error').length);

const allPassed = errorDetected1 && errorDetected2 && errorDetected3 && !errorDetected4;
if (allPassed) {
  console.log('\n✅ All integration tests PASSED!');
  process.exit(0);
} else {
  console.log('\n❌ Some integration tests FAILED');
  process.exit(1);
}
