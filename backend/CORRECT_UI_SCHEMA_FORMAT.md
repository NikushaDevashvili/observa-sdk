# Correct Schema Format for Tinybird UI

## The Issue

The error "TENANT_ID is not a valid option" happens because Tinybird UI's "Write schema" interface expects **NO COMMAS** - just space-separated format.

## Correct Format (NO COMMAS!)

**Clear the text box and paste this instead:**

```
tenant_id String
project_id String
environment Enum8('dev' = 1, 'prod' = 2)
timestamp DateTime64(3)
trace_id String
span_id String
parent_span_id Nullable(String)
query String
context Nullable(String)
model Nullable(String)
metadata_json String
response String
response_length UInt32
tokens_prompt Nullable(UInt32)
tokens_completion Nullable(UInt32)
tokens_total Nullable(UInt32)
latency_ms UInt32
ttfb_ms Nullable(UInt32)
streaming_ms Nullable(UInt32)
status Nullable(UInt16)
status_text Nullable(String)
finish_reason Nullable(String)
response_id Nullable(String)
system_fingerprint Nullable(String)
headers_json String
```

## Key Points

- ✅ **NO COMMAS** between columns
- ✅ One column per line
- ✅ Format: `column_name DataType`
- ✅ For Nullable: `column_name Nullable(DataType)`
- ✅ For Enum: `column_name Enum8('value1' = 1, 'value2' = 2)`

The UI parser is likely interpreting commas as separators for options, hence the error "TENANT_ID is not a valid option" - it thinks you're trying to pass `tenant_id` as an option to `String`.

