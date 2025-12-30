# Creating Traces Datasource in Tinybird

## Option 1: Using Tinybird CLI (Recommended - Full Control)

The CLI supports all advanced features including partitioning and sorting keys.

### Steps:

1. **Make sure you're in the backend directory:**

   ```bash
   cd backend
   ```

2. **Login to Tinybird (if not already):**

   ```bash
   tb auth
   ```

3. **Push the datasource:**
   ```bash
   tb push datasources/traces.datasource
   ```

This will create the datasource with:

- ✅ Proper partitioning by `toYYYYMM(date)`
- ✅ Sorting key for efficient queries: `tenant_id, project_id, timestamp, trace_id`
- ✅ TTL set to 90 days

## Option 2: Via Tinybird UI (Limited - Schema Only)

The UI only accepts column definitions. You'll need to add partitioning/sorting later.

### Steps:

1. Go to https://ui.tinybird.co
2. Navigate to **Data Sources**
3. Click **"Create Data Source"**
4. Name it: `traces`
5. Paste ONLY the column definitions (schema):

```
tenant_id String
project_id String
environment Enum8('dev' = 1, 'prod' = 2)
timestamp DateTime64(3)
date Date MATERIALIZED toDate(timestamp)
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

6. Click **"Create"**

**Note**: After creation via UI, you'll need to add partitioning and sorting keys via SQL or CLI for optimal performance.

## Option 3: Via SQL After UI Creation

If you created via UI, you can optimize it later with SQL:

```sql
ALTER TABLE traces
MODIFY PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, project_id, timestamp, trace_id);
```

## Recommended Approach

**Use Option 1 (CLI)** - It's the cleanest way to get all features working correctly from the start.

The `traces.datasource` file uses the correct Tinybird syntax:

- `ENGINE_PARTITION_KEY` instead of `PARTITION BY`
- `ENGINE_SORTING_KEY` instead of `ORDER BY`
- `ENGINE_TTL` for data retention
