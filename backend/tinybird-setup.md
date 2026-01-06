# Tinybird Setup Guide

## Step 1: Create Tinybird Datasource

Create a datasource named `traces` with the following schema:

### ClickHouse Schema

```sql
CREATE TABLE traces (
    -- Tenant isolation (partition key)
    tenant_id String,
    project_id String,
    environment Enum8('dev' = 1, 'prod' = 2),

    -- Time partitioning (for retention)
    timestamp DateTime64(3),
    date Date MATERIALIZED toDate(timestamp),

    -- Trace identifiers
    trace_id String,
    span_id String,
    parent_span_id Nullable(String),

    -- Request data
    query String,
    context Nullable(String),
    model Nullable(String),
    metadata_json String, -- JSON string for flexibility

    -- Response data
    response String,
    response_length UInt32,

    -- Token usage
    tokens_prompt Nullable(UInt32),
    tokens_completion Nullable(UInt32),
    tokens_total Nullable(UInt32),

    -- Performance metrics
    latency_ms UInt32,
    ttfb_ms Nullable(UInt32),
    streaming_ms Nullable(UInt32),

    -- Response metadata
    status Nullable(UInt16),
    status_text Nullable(String),
    finish_reason Nullable(String),
    response_id Nullable(String),
    system_fingerprint Nullable(String),

    -- Headers (JSON for flexibility)
    headers_json String
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, timestamp, trace_id)
TTL date + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
```

### Tinybird Datasource Creation

**Option A: Via Tinybird UI**

1. Go to https://ui.tinybird.co
2. Navigate to Data Sources
3. Click "Create Data Source"
4. Name it `traces`
5. Paste the SQL schema above
6. Click "Create"

**Option B: Via Tinybird CLI**

```bash
# Install Tinybird CLI if not installed
npm install -g @tinybird/cli

# Login
tb auth

# Create datasource
tb push datasources/traces.datasource
```

Create `datasources/traces.datasource`:

```
SCHEMA >
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

ENGINE MergeTree
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, timestamp, trace_id)
TTL date + INTERVAL 90 DAY
```

## Step 2: Generate Tenant-Scoped Tokens

For each tenant, you need to create a Tinybird token that is scoped to their `tenant_id`.

### Via Tinybird UI:

1. Go to Tokens in Tinybird UI
2. Click "Create Token"
3. Set permissions:
   - **Read**: No (or yes if you want tenants to query their own data)
   - **Write**: Yes
   - **Admin**: No
4. Set SQL scope:
   ```sql
   tenant_id = '{your-tenant-id}'
   ```
5. Save the token

### Via Tinybird API:

```bash
# Get your admin token from Tinybird UI
TINYBIRD_ADMIN_TOKEN="your-admin-token"

# Create token for tenant
curl -X POST "https://api.tinybird.co/v0/tokens" \
  -H "Authorization: Bearer $TINYBIRD_ADMIN_TOKEN" \
  -d "name=tenant-{tenant-id}" \
  -d "permission=write" \
  -d "scope=tenant_id = '{tenant-id}'"
```

## Step 3: Update Backend with Real Tokens

When provisioning tokens via the backend API, use the real Tinybird token:

```bash
curl -X POST http://localhost:3000/api/v1/auth/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "your-tenant-id",
    "projectId": "your-project-id",
    "environment": "dev",
    "tinybirdToken": "p.your-real-tinybird-token-here"
  }'
```

## Step 4: Test End-to-End

After setting up:

1. Create tenant/project in backend
2. Get Tinybird token for that tenant
3. Provision tokens via backend API (with real Tinybird token)
4. Use the API key with SDK
5. Send traces - they should now successfully reach Tinybird!

## Verification

Query Tinybird to verify traces are being stored:

```sql
SELECT
    tenant_id,
    project_id,
    count(*) as trace_count,
    avg(latency_ms) as avg_latency,
    sum(tokens_total) as total_tokens
FROM traces
WHERE tenant_id = 'your-tenant-id'
  AND date >= today() - 1
GROUP BY tenant_id, project_id
```




