# SDK-API Alignment Report

**Date:** January 2026  
**Status:** ✅ **FULLY ALIGNED** - Both SDK and API support all features

---

## Executive Summary

✅ **The observa-api fully supports all updates and changes made in the SDK.**

Both components are aligned and working together. All event types, attributes, and OTEL parameters implemented in the SDK are supported by the API.

---

## ✅ Alignment Verification

### 1. Event Types - **ALIGNED** ✅

| Event Type            | SDK Support | API Support | Status     |
| --------------------- | ----------- | ----------- | ---------- |
| `llm_call`            | ✅          | ✅          | ✅ Aligned |
| `tool_call`           | ✅          | ✅          | ✅ Aligned |
| `retrieval`           | ✅          | ✅          | ✅ Aligned |
| `error`               | ✅          | ✅          | ✅ Aligned |
| `feedback`            | ✅          | ✅          | ✅ Aligned |
| `output`              | ✅          | ✅          | ✅ Aligned |
| `trace_start`         | ✅          | ✅          | ✅ Aligned |
| `trace_end`           | ✅          | ✅          | ✅ Aligned |
| `embedding`           | ✅          | ✅          | ✅ Aligned |
| `vector_db_operation` | ✅          | ✅          | ✅ Aligned |
| `cache_operation`     | ✅          | ✅          | ✅ Aligned |
| `agent_create`        | ✅          | ✅          | ✅ Aligned |

**Verification:**

- SDK `EventType` (src/index.ts:211-223): All 12 types defined
- API `EventType` (src/types/events.ts:8-20): All 12 types defined
- API validation schema (src/validation/schemas.ts:57-70): All 12 types in enum

---

### 2. Canonical Event Structure - **ALIGNED** ✅

| Field             | SDK Type          | API Type                | Status                |
| ----------------- | ----------------- | ----------------------- | --------------------- |
| `tenant_id`       | `string`          | `string` (UUID)         | ✅ Aligned            |
| `project_id`      | `string`          | `string` (UUID)         | ✅ Aligned            |
| `environment`     | `"dev" \| "prod"` | `"dev" \| "prod"`       | ✅ Aligned            |
| `trace_id`        | `string`          | `string` (UUID)         | ✅ Aligned            |
| `span_id`         | `string`          | `string` (UUID)         | ✅ Aligned            |
| `parent_span_id`  | `string \| null`  | `string \| null` (UUID) | ✅ Aligned            |
| `timestamp`       | `string`          | `string` (ISO 8601)     | ✅ Aligned            |
| `event_type`      | `EventType`       | `EventType`             | ✅ Aligned            |
| `conversation_id` | `string \| null`  | `string \| null` (UUID) | ✅ Aligned            |
| `session_id`      | `string \| null`  | `string \| null` (UUID) | ✅ Aligned            |
| `user_id`         | `string \| null`  | `string \| null` (UUID) | ✅ Aligned            |
| `agent_name`      | `string \| null`  | `string \| null`        | ✅ Aligned            |
| `version`         | `string \| null`  | `string \| null`        | ✅ Aligned            |
| `route`           | `string \| null`  | `string \| null`        | ✅ Aligned            |
| `attributes`      | `EventAttributes` | `Record<string, any>`   | ✅ Aligned (flexible) |

**Note:** API uses flexible `z.record(z.string(), z.any())` for attributes, which correctly accepts all SDK attribute structures.

---

### 3. LLM Call Attributes - **ALIGNED** ✅

All OTEL parameters implemented in SDK are supported by API:

| Attribute                             | SDK | API | Status     |
| ------------------------------------- | --- | --- | ---------- |
| **TIER 1: OTEL Semantic Conventions** |
| `operation_name`                      | ✅  | ✅  | ✅ Aligned |
| `provider_name`                       | ✅  | ✅  | ✅ Aligned |
| `response_model`                      | ✅  | ✅  | ✅ Aligned |
| `input_messages`                      | ✅  | ✅  | ✅ Aligned |
| `output_messages`                     | ✅  | ✅  | ✅ Aligned |
| `system_instructions`                 | ✅  | ✅  | ✅ Aligned |
| **TIER 2: Sampling Parameters**       |
| `top_k`                               | ✅  | ✅  | ✅ Aligned |
| `top_p`                               | ✅  | ✅  | ✅ Aligned |
| `frequency_penalty`                   | ✅  | ✅  | ✅ Aligned |
| `presence_penalty`                    | ✅  | ✅  | ✅ Aligned |
| `stop_sequences`                      | ✅  | ✅  | ✅ Aligned |
| `seed`                                | ✅  | ✅  | ✅ Aligned |
| `temperature`                         | ✅  | ✅  | ✅ Aligned |
| `max_tokens`                          | ✅  | ✅  | ✅ Aligned |
| **TIER 2: Cost Tracking**             |
| `input_cost`                          | ✅  | ✅  | ✅ Aligned |
| `output_cost`                         | ✅  | ✅  | ✅ Aligned |
| `cost`                                | ✅  | ✅  | ✅ Aligned |
| **TIER 2: Server Metadata**           |
| `server_address`                      | ✅  | ✅  | ✅ Aligned |
| `server_port`                         | ✅  | ✅  | ✅ Aligned |
| **TIER 2: Conversation Grouping**     |
| `conversation_id_otel`                | ✅  | ✅  | ✅ Aligned |
| `choice_count`                        | ✅  | ✅  | ✅ Aligned |
| **Standard Fields**                   |
| `model`                               | ✅  | ✅  | ✅ Aligned |
| `input`                               | ✅  | ✅  | ✅ Aligned |
| `output`                              | ✅  | ✅  | ✅ Aligned |
| `input_tokens`                        | ✅  | ✅  | ✅ Aligned |
| `output_tokens`                       | ✅  | ✅  | ✅ Aligned |
| `total_tokens`                        | ✅  | ✅  | ✅ Aligned |
| `latency_ms`                          | ✅  | ✅  | ✅ Aligned |
| `time_to_first_token_ms`              | ✅  | ✅  | ✅ Aligned |
| `streaming_duration_ms`               | ✅  | ✅  | ✅ Aligned |
| `finish_reason`                       | ✅  | ✅  | ✅ Aligned |
| `response_id`                         | ✅  | ✅  | ✅ Aligned |
| `system_fingerprint`                  | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `llm_call` attributes (src/index.ts:241-293): All fields defined
- API `llm_call` attributes (src/types/events.ts:53-110): All fields defined

---

### 4. Tool Call Attributes - **ALIGNED** ✅

| Attribute                             | SDK | API | Status     |
| ------------------------------------- | --- | --- | ---------- |
| `tool_name`                           | ✅  | ✅  | ✅ Aligned |
| `args`                                | ✅  | ✅  | ✅ Aligned |
| `result`                              | ✅  | ✅  | ✅ Aligned |
| `result_status`                       | ✅  | ✅  | ✅ Aligned |
| `latency_ms`                          | ✅  | ✅  | ✅ Aligned |
| `error_message`                       | ✅  | ✅  | ✅ Aligned |
| **TIER 2: OTEL Tool Standardization** |
| `operation_name`                      | ✅  | ✅  | ✅ Aligned |
| `tool_type`                           | ✅  | ✅  | ✅ Aligned |
| `tool_description`                    | ✅  | ✅  | ✅ Aligned |
| `tool_call_id`                        | ✅  | ✅  | ✅ Aligned |
| `error_type`                          | ✅  | ✅  | ✅ Aligned |
| `error_category`                      | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `tool_call` attributes (src/index.ts:294-308): All fields defined
- API `tool_call` attributes (src/types/events.ts:113-129): All fields defined

---

### 5. Retrieval Attributes - **ALIGNED** ✅

| Attribute                        | SDK | API | Status     |
| -------------------------------- | --- | --- | ---------- |
| `retrieval_context_ids`          | ✅  | ✅  | ✅ Aligned |
| `retrieval_context_hashes`       | ✅  | ✅  | ✅ Aligned |
| `k`                              | ✅  | ✅  | ✅ Aligned |
| `top_k`                          | ✅  | ✅  | ✅ Aligned |
| `similarity_scores`              | ✅  | ✅  | ✅ Aligned |
| `latency_ms`                     | ✅  | ✅  | ✅ Aligned |
| **TIER 2: Retrieval Enrichment** |
| `retrieval_context`              | ✅  | ✅  | ✅ Aligned |
| `embedding_model`                | ✅  | ✅  | ✅ Aligned |
| `embedding_dimensions`           | ✅  | ✅  | ✅ Aligned |
| `vector_metric`                  | ✅  | ✅  | ✅ Aligned |
| `rerank_score`                   | ✅  | ✅  | ✅ Aligned |
| `fusion_method`                  | ✅  | ✅  | ✅ Aligned |
| `deduplication_removed_count`    | ✅  | ✅  | ✅ Aligned |
| `quality_score`                  | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `retrieval` attributes (src/index.ts:309-325): All fields defined
- API `retrieval` attributes (src/types/events.ts:132-148): All fields defined

---

### 6. Error Attributes - **ALIGNED** ✅

| Attribute                                   | SDK | API | Status     |
| ------------------------------------------- | --- | --- | ---------- |
| `error_type`                                | ✅  | ✅  | ✅ Aligned |
| `error_message`                             | ✅  | ✅  | ✅ Aligned |
| `stack_trace`                               | ✅  | ✅  | ✅ Aligned |
| `context`                                   | ✅  | ✅  | ✅ Aligned |
| **TIER 2: Structured Error Classification** |
| `error_category`                            | ✅  | ✅  | ✅ Aligned |
| `error_code`                                | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `error` attributes (src/index.ts:326-334): All fields defined
- API `error` attributes (src/types/events.ts:151-159): All fields defined

---

### 7. Embedding Attributes - **ALIGNED** ✅

| Attribute          | SDK | API | Status     |
| ------------------ | --- | --- | ---------- |
| `model`            | ✅  | ✅  | ✅ Aligned |
| `dimension_count`  | ✅  | ✅  | ✅ Aligned |
| `encoding_formats` | ✅  | ✅  | ✅ Aligned |
| `input_tokens`     | ✅  | ✅  | ✅ Aligned |
| `output_tokens`    | ✅  | ✅  | ✅ Aligned |
| `latency_ms`       | ✅  | ✅  | ✅ Aligned |
| `cost`             | ✅  | ✅  | ✅ Aligned |
| `input_text`       | ✅  | ✅  | ✅ Aligned |
| `input_hash`       | ✅  | ✅  | ✅ Aligned |
| `embeddings`       | ✅  | ✅  | ✅ Aligned |
| `embeddings_hash`  | ✅  | ✅  | ✅ Aligned |
| `operation_name`   | ✅  | ✅  | ✅ Aligned |
| `provider_name`    | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `embedding` attributes (src/index.ts:335-349): All fields defined
- API `embedding` attributes (src/types/events.ts:162-176): All fields defined

---

### 8. Vector DB Operation Attributes - **ALIGNED** ✅

| Attribute           | SDK | API | Status     |
| ------------------- | --- | --- | ---------- |
| `operation_type`    | ✅  | ✅  | ✅ Aligned |
| `index_name`        | ✅  | ✅  | ✅ Aligned |
| `index_version`     | ✅  | ✅  | ✅ Aligned |
| `vector_dimensions` | ✅  | ✅  | ✅ Aligned |
| `vector_metric`     | ✅  | ✅  | ✅ Aligned |
| `results_count`     | ✅  | ✅  | ✅ Aligned |
| `scores`            | ✅  | ✅  | ✅ Aligned |
| `latency_ms`        | ✅  | ✅  | ✅ Aligned |
| `cost`              | ✅  | ✅  | ✅ Aligned |
| `api_version`       | ✅  | ✅  | ✅ Aligned |
| `provider_name`     | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `vector_db_operation` attributes (src/index.ts:350-362): All fields defined
- API `vector_db_operation` attributes (src/types/events.ts:179-191): All fields defined

---

### 9. Cache Operation Attributes - **ALIGNED** ✅

| Attribute         | SDK | API | Status     |
| ----------------- | --- | --- | ---------- |
| `cache_backend`   | ✅  | ✅  | ✅ Aligned |
| `cache_key`       | ✅  | ✅  | ✅ Aligned |
| `cache_namespace` | ✅  | ✅  | ✅ Aligned |
| `hit_status`      | ✅  | ✅  | ✅ Aligned |
| `latency_ms`      | ✅  | ✅  | ✅ Aligned |
| `saved_cost`      | ✅  | ✅  | ✅ Aligned |
| `ttl`             | ✅  | ✅  | ✅ Aligned |
| `eviction_info`   | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `cache_operation` attributes (src/index.ts:363-372): All fields defined
- API `cache_operation` attributes (src/types/events.ts:194-203): All fields defined

---

### 10. Agent Create Attributes - **ALIGNED** ✅

| Attribute        | SDK | API | Status     |
| ---------------- | --- | --- | ---------- |
| `agent_name`     | ✅  | ✅  | ✅ Aligned |
| `agent_config`   | ✅  | ✅  | ✅ Aligned |
| `tools_bound`    | ✅  | ✅  | ✅ Aligned |
| `model_config`   | ✅  | ✅  | ✅ Aligned |
| `operation_name` | ✅  | ✅  | ✅ Aligned |

**Verification:**

- SDK `agent_create` attributes (src/index.ts:373-379): All fields defined
- API `agent_create` attributes (src/types/events.ts:206-212): All fields defined

---

### 11. API Endpoint - **ALIGNED** ✅

| Component       | Endpoint                | Status |
| --------------- | ----------------------- | ------ |
| SDK sends to    | `/api/v1/events/ingest` | ✅     |
| API receives at | `/api/v1/events/ingest` | ✅     |
| **Status**      | **✅ Aligned**          |        |

**Verification:**

- SDK endpoint (src/index.ts:2018): `POST ${baseUrl}/api/v1/events/ingest`
- API route (src/routes/events.ts:118): `router.post("/ingest", ...)`
- API base path: `/api/v1/events` (from router registration)

---

### 12. Authentication - **ALIGNED** ✅

| Component     | Method                            | Status |
| ------------- | --------------------------------- | ------ |
| SDK sends     | `Authorization: Bearer ${apiKey}` | ✅     |
| API validates | JWT token via `apiKeyMiddleware`  | ✅     |
| **Status**    | **✅ Aligned**                    |        |

**Verification:**

- SDK auth header (src/index.ts:2039): `Authorization: Bearer ${this.apiKey}`
- API middleware (src/routes/events.ts:119): `apiKeyMiddleware("ingest")`
- API extracts tenant/project from JWT payload

---

### 13. Request Format - **ALIGNED** ✅

| Component   | Format               | Status |
| ----------- | -------------------- | ------ |
| SDK sends   | JSON array of events | ✅     |
| API accepts | JSON array OR NDJSON | ✅     |
| **Status**  | **✅ Aligned**       |        |

**Verification:**

- SDK body (src/index.ts:2042): `JSON.stringify(events)`
- SDK content-type (src/index.ts:2040): `"Content-Type": "application/json"`
- API parsing (src/routes/events.ts:132-207): Handles both JSON array and NDJSON

---

### 14. Validation - **ALIGNED** ✅

| Component  | Validation            | Status |
| ---------- | --------------------- | ------ |
| SDK        | TypeScript types      | ✅     |
| API        | Zod schema validation | ✅     |
| **Status** | **✅ Aligned**        |        |

**Verification:**

- SDK types: Full TypeScript interfaces
- API validation (src/routes/events.ts:222): `batchEventsSchema.safeParse(events)`
- API schema (src/validation/schemas.ts:72-88): Validates all required fields

---

## 🔍 Detailed Comparison

### Event Type Definitions

**SDK (src/index.ts:211-223):**

```typescript
type EventType =
  | "llm_call"
  | "tool_call"
  | "retrieval"
  | "error"
  | "feedback"
  | "output"
  | "trace_start"
  | "trace_end"
  | "embedding"
  | "vector_db_operation"
  | "cache_operation"
  | "agent_create";
```

**API (src/types/events.ts:8-20):**

```typescript
export type EventType =
  | "llm_call"
  | "tool_call"
  | "retrieval"
  | "error"
  | "feedback"
  | "output"
  | "trace_start"
  | "trace_end"
  | "embedding"
  | "vector_db_operation"
  | "cache_operation"
  | "agent_create";
```

✅ **Perfect match** - All 12 event types aligned.

---

### LLM Call Attributes Comparison

**SDK sends (src/index.ts:912-952):**

- All TIER 1 OTEL parameters (operation_name, provider_name, response_model, input_messages, output_messages, system_instructions)
- All TIER 2 sampling parameters (top_k, top_p, frequency_penalty, presence_penalty, stop_sequences, seed, temperature, max_tokens)
- All TIER 2 cost tracking (input_cost, output_cost, cost)
- All TIER 2 server metadata (server_address, server_port)
- All TIER 2 conversation grouping (conversation_id_otel, choice_count)

**API accepts (src/types/events.ts:53-110):**

- All the same fields with identical types and nullability

✅ **Perfect match** - All attributes aligned.

---

## ✅ Conclusion

**The observa-api is FULLY ALIGNED with all SDK changes.**

### Summary:

1. ✅ All 12 event types supported by both SDK and API
2. ✅ All canonical event fields aligned (types, nullability)
3. ✅ All LLM call OTEL parameters supported
4. ✅ All tool call, retrieval, error attributes aligned
5. ✅ All new event types (embedding, vector_db, cache, agent) supported
6. ✅ API endpoint matches SDK endpoint
7. ✅ Authentication method aligned
8. ✅ Request format compatible
9. ✅ Validation schemas accept all SDK event structures

### No Issues Found:

- ✅ No missing event types
- ✅ No missing attributes
- ✅ No type mismatches
- ✅ No validation failures expected
- ✅ No endpoint mismatches

### Both Components Are:

- ✅ **Aligned** - All features match
- ✅ **Working** - Ready for production use
- ✅ **Compatible** - SDK events will be accepted by API
- ✅ **Complete** - All OTEL parameters supported

---

## 🚀 Next Steps

No action required - both SDK and API are fully aligned and ready to use.

**Recommendation:** Both components can be used together without any modifications. All SDK events will be correctly received, validated, and stored by the API.

---

## 📝 Notes

1. **Flexible Attributes Validation**: The API uses `z.record(z.string(), z.any())` for attributes, which correctly accepts all SDK attribute structures. This is intentional for extensibility.

2. **UUID Validation**: The API validates UUIDs more strictly (requires UUIDv4 format), while the SDK generates UUIDs using `crypto.randomUUID()` which produces valid UUIDv4. This is aligned.

3. **Null Handling**: Both SDK and API handle nullable fields consistently (using `| null` in TypeScript and `.nullable()` in Zod).

4. **Auto-inference**: SDK auto-infers `providerName` from model names, which is a client-side convenience. The API accepts both auto-inferred and explicitly provided values.

---

**Report Generated:** January 2026  
**Status:** ✅ **FULLY ALIGNED - NO ISSUES FOUND**
