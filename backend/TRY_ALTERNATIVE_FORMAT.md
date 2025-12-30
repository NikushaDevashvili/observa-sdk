# Try Alternative Schema Format

The error "TENANT_ID is not a valid option" suggests Tinybird might be misinterpreting the format.

## Option 1: Try WITH Commas

In the "Write schema" interface, try pasting this format (with commas):

```
tenant_id String,
project_id String,
environment Enum8('dev' = 1, 'prod' = 2),
timestamp DateTime64(3),
trace_id String,
span_id String,
parent_span_id Nullable(String),
query String,
context Nullable(String),
model Nullable(String),
metadata_json String,
response String,
response_length UInt32,
tokens_prompt Nullable(UInt32),
tokens_completion Nullable(UInt32),
tokens_total Nullable(UInt32),
latency_ms UInt32,
ttfb_ms Nullable(UInt32),
streaming_ms Nullable(UInt32),
status Nullable(UInt16),
status_text Nullable(String),
finish_reason Nullable(String),
response_id Nullable(String),
system_fingerprint Nullable(String),
headers_json String
```

## Option 2: Try SQL CREATE TABLE Format

If the above doesn't work, try SQL format:

```sql
CREATE TABLE traces (
    tenant_id String,
    project_id String,
    environment Enum8('dev' = 1, 'prod' = 2),
    timestamp DateTime64(3),
    trace_id String,
    span_id String,
    parent_span_id Nullable(String),
    query String,
    context Nullable(String),
    model Nullable(String),
    metadata_json String,
    response String,
    response_length UInt32,
    tokens_prompt Nullable(UInt32),
    tokens_completion Nullable(UInt32),
    tokens_total Nullable(UInt32),
    latency_ms UInt32,
    ttfb_ms Nullable(UInt32),
    streaming_ms Nullable(UInt32),
    status Nullable(UInt16),
    status_text Nullable(String),
    finish_reason Nullable(String),
    response_id Nullable(String),
    system_fingerprint Nullable(String),
    headers_json String
)
```

## Option 3: Rename tenant_id (If Reserved Keyword)

If `tenant_id` is causing issues, try renaming it temporarily to test:

```
t_id String,
project_id String,
...
```

Then change it back after creation, or update our code to use the new name.

Try Option 1 first (with commas) - that's the most likely format the UI expects.

