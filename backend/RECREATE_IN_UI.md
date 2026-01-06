# Recreate Datasource in UI (JSON Format)

Since CLI auth is having issues, let's recreate the datasource directly in the UI, ensuring it's created as JSON (not CSV).

## Step 1: Delete Current Datasource

1. In Tinybird UI, go to your `traces` datasource
2. Click the "..." button (three dots)
3. Click **"Delete"**
4. Confirm deletion

## Step 2: Create New Datasource (JSON Format)

1. In Tinybird UI, go to **Data Sources**
2. Click **"Create Data Source"** or **"+"**
3. **Important**: Look for a format selector (JSON vs CSV)
   - If you see options, choose **"JSON"** format
   - If no format selector, proceed to next step
4. Name it: `traces`
5. Paste the schema (column definitions only, one per line):

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

6. **Don't add ENGINE, PARTITION, or ORDER BY** - Tinybird UI doesn't support these
7. Click **"Create"**

## Step 3: Verify It's JSON Format

After creation:
1. Click "..." → "Append data"
2. **"Events API"** should now be clickable (not greyed out)
3. If Events API works, it's a JSON datasource! ✅

## Step 4: Test

After recreating, test with SDK:

```bash
cd backend
# Recreate tenant/project and provision token
./test-api.sh

# Then provision with real Tinybird token
curl -X POST http://localhost:3000/api/v1/auth/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR-TENANT-ID",
    "projectId": "YOUR-PROJECT-ID",
    "tinybirdToken": "p.eyJ1IjogImVmNGNjNGFlLTExZDAtNDVhNy1hNTcxLTJiZDg1NWNkZDZkNCIsICJpZCI6ICJiZTgxMjhhOS1jODkzLTQxNTEtYjM1Yy1mOTJiOTVlZjUyMjAiLCAiaG9zdCI6ICJnY3AtZXVyb3BlLXdlc3QyIn0.hUl1g7KczdKmDf7SClKAJujLz5NqQjFK3AfTG5Epk9Q"
  }'

# Test SDK
cd ..
export OBSERVA_API_KEY="api-key-from-above"
export OBSERVA_API_URL="http://localhost:3000"
node test-sdk.js
```

## Note

The key difference is ensuring the datasource is created as **JSON format**, not CSV. The UI might default to CSV when you paste column definitions, so look for any format options during creation.





