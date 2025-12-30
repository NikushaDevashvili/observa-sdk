# Tinybird Datasource Setup

## Option 1: Via Tinybird UI (Recommended)

1. Go to https://ui.tinybird.co
2. Navigate to **Data Sources**
3. Click **"Create Data Source"**
4. Name it `traces`
5. Copy the schema from `traces.datasource` file below
6. Paste it into the schema editor
7. Click **"Create"**

## Option 2: Via Tinybird CLI

```bash
# Create datasource
tb datasource create traces \
  --schema "$(cat datasources/traces.datasource | grep -A 100 '^SCHEMA')"
```

Or use the SQL directly:

```sql
CREATE TABLE traces (
    tenant_id String,
    project_id String,
    environment Enum8('dev' = 1, 'prod' = 2),
    timestamp DateTime64(3),
    date Date MATERIALIZED toDate(timestamp),
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
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, timestamp, trace_id)
TTL date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
```

## Next Steps

After creating the datasource:

1. Create tenant-scoped tokens (see `QUICK_START.md`)
2. Test end-to-end flow
3. Verify traces are being stored

