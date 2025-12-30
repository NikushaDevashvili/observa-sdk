# Create Datasource in Tinybird UI - Step by Step

## Step 1: Click "Write schema"

In the modal that appears when you click "Create Data Source", click **"Write schema"** (the one with the keyboard icon).

This option allows you to manually define the schema without needing to upload a file first.

## Step 2: Define Your Schema

After clicking "Write schema", you should see a text area or form where you can enter your schema.

**Paste this schema** (one column per line, no commas):

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

## Step 3: Name Your Datasource

- Name it: `traces`
- Click "Create" or "Save"

## Step 4: Verify It's JSON Format

After creation:
1. Click "..." → "Append data"
2. **"Events API"** should be clickable (not greyed out)
3. If Events API works, you're good! ✅

## Why "Write schema"?

- "Events API" = for ingesting data via API (but datasource must exist first)
- "File upload" = creates datasource from a file (might default to CSV)
- "Write schema" = manually define schema (ensures JSON format)
- "Remote URL" = pull from URL

"Write schema" is the safest option to ensure it's created as a JSON datasource.


