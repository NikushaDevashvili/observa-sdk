# SDK Migration to Canonical Events - Complete

## Summary

The Observa SDK has been successfully migrated from the legacy `/api/v1/traces/ingest` endpoint to the new `/api/v1/events/ingest` endpoint using canonical events format.

## Changes Made

### 1. Updated Event Format

- **Before**: SDK sent a single `TraceData` object to `/api/v1/traces/ingest`
- **After**: SDK converts `TraceData` to canonical events and sends to `/api/v1/events/ingest`

### 2. Canonical Event Conversion

The SDK now converts each trace into multiple canonical events:

1. **trace_start** - Beginning of trace with metadata
2. **llm_call** - LLM call details (model, input, output, tokens, latency)
3. **output** - Final output/response
4. **trace_end** - End of trace with summary statistics

### 3. Updated API Endpoint

- Changed from `/api/v1/traces/ingest` to `/api/v1/events/ingest`
- Events are sent as a JSON array (batch format)
- Same authentication (Bearer token)

### 4. Backward Compatibility

- Existing SDK API remains unchanged (`observa.track()` works the same)
- Pretty logging in dev mode still works
- All existing functionality preserved

## Code Changes

### New Types Added

```typescript
type EventType = 
  | "llm_call"
  | "tool_call"
  | "retrieval"
  | "error"
  | "feedback"
  | "output"
  | "trace_start"
  | "trace_end";

interface CanonicalEvent {
  tenant_id: string;
  project_id: string;
  environment: "dev" | "prod";
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  timestamp: string;
  event_type: EventType;
  conversation_id?: string | null;
  session_id?: string | null;
  user_id?: string | null;
  attributes: { ... };
}
```

### Key Methods Updated

1. **`traceDataToCanonicalEvents()`** - Converts legacy TraceData to canonical events
2. **`sendEvents()`** - Sends canonical events to `/api/v1/events/ingest`
3. **`_sendEventsWithRetry()`** - Retry logic for events (replaces `_sendTraceWithRetry`)
4. **`_doFlush()`** - Groups events by trace_id before sending

### Buffer Changes

- Event buffer now stores `CanonicalEvent[]` instead of `TraceData[]`
- Events are grouped by trace_id before sending (ensures complete traces)

## Testing

To test the updated SDK:

1. **Build the SDK:**
   ```bash
   cd observa-sdk
   npm run build
   ```

2. **Test with your application:**
   - Use the SDK as before (no API changes needed)
   - Check that events appear in the dashboard
   - Verify that traces show correct structure

3. **Use the simulation script:**
   ```bash
   cd observa-api
   node scripts/load-simulation-events.js <JWT_TOKEN>
   ```

## Next Steps (Future Enhancements)

While the basic migration is complete, the following enhancements can be added:

1. **Add explicit tracking methods:**
   - `trackToolCall()` - Track tool/function calls
   - `trackRetrieval()` - Track RAG/vector DB queries
   - `trackError()` - Track errors explicitly
   - `startTrace()` / `endTrace()` - Manual trace management

2. **Span hierarchy support:**
   - Track parent-child relationships for nested operations
   - Support multiple LLM calls in a single trace
   - Support parallel tool execution

3. **Enhanced error tracking:**
   - Automatic error capture from try/catch blocks
   - Stack trace inclusion
   - Error context

4. **Feedback tracking:**
   - `trackFeedback()` - User feedback (like/dislike/rating)

## API Compatibility

- ✅ **Backward Compatible**: Existing code using `observa.track()` continues to work
- ✅ **Same Authentication**: Uses Bearer token (no changes)
- ✅ **Same Configuration**: All config options unchanged
- ✅ **Dev Mode**: Pretty logging still works in development

## Migration Status

- ✅ Code updated and building successfully
- ✅ TypeScript types correct
- ✅ Backward compatibility maintained
- ⏳ Testing required (manual testing with real application)
- ⏳ Future enhancements (tool calls, retrievals, etc.)

## Files Modified

- `src/index.ts` - Main SDK implementation
  - Added `CanonicalEvent` type and conversion logic
  - Updated endpoint to `/api/v1/events/ingest`
  - Added `traceDataToCanonicalEvents()` method
  - Updated buffer and flush logic

## Documentation

See `../observa-api/SDK_MIGRATION_GUIDE.md` for:
- Complete migration guide
- Canonical events reference
- Implementation examples
- API endpoint details

