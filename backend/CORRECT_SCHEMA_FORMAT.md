# Correct Tinybird UI Schema Format

Based on the Tinybird UI example, the correct format requires:

1. **`SCHEMA >` header** at the top
2. **Backticks around column names**: `` `column_name` ``
3. **JSON path mappings** for each column: `` `json:$.column_name` ``
4. **Commas between columns**
5. **ENGINE definitions** at the bottom

## Complete Schema

Paste this into the Tinybird UI "Write schema" modal:

```
SCHEMA >
    `tenant_id` String `json:$.tenant_id`,
    `project_id` String `json:$.project_id`,
    `environment` Enum8('dev' = 1, 'prod' = 2) `json:$.environment`,
    `timestamp` DateTime64(3) `json:$.timestamp`,
    `trace_id` String `json:$.trace_id`,
    `span_id` String `json:$.span_id`,
    `parent_span_id` Nullable(String) `json:$.parent_span_id`,
    `query` String `json:$.query`,
    `context` Nullable(String) `json:$.context`,
    `model` Nullable(String) `json:$.model`,
    `metadata_json` String `json:$.metadata_json`,
    `response` String `json:$.response`,
    `response_length` UInt32 `json:$.response_length`,
    `tokens_prompt` Nullable(UInt32) `json:$.tokens_prompt`,
    `tokens_completion` Nullable(UInt32) `json:$.tokens_completion`,
    `tokens_total` Nullable(UInt32) `json:$.tokens_total`,
    `latency_ms` UInt32 `json:$.latency_ms`,
    `ttfb_ms` Nullable(UInt32) `json:$.ttfb_ms`,
    `streaming_ms` Nullable(UInt32) `json:$.streaming_ms`,
    `status` Nullable(UInt16) `json:$.status`,
    `status_text` Nullable(String) `json:$.status_text`,
    `finish_reason` Nullable(String) `json:$.finish_reason`,
    `response_id` Nullable(String) `json:$.response_id`,
    `system_fingerprint` Nullable(String) `json:$.system_fingerprint`,
    `headers_json` String `json:$.headers_json`

ENGINE "MergeTree"
ENGINE_SORTING_KEY "tenant_id, project_id, timestamp, trace_id"
ENGINE_TTL ""
ENGINE_PARTITION_KEY ""
```

## Key Format Rules

- ✅ Start with `SCHEMA >`
- ✅ Use backticks around column names: `` `tenant_id` ``
- ✅ Include JSON path mapping: `` `json:$.tenant_id` ``
- ✅ Separate columns with commas
- ✅ Include ENGINE definitions at the bottom
- ✅ Last column should NOT have a trailing comma

## After Creation

1. Click "Next →"
2. Name your datasource: `traces`
3. Click "Create"
4. Verify it's JSON format by checking "Append data" → "Events API" is clickable

