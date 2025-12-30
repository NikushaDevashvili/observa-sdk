# Provision Your Token - Next Steps

## Important: Enable Append Permission First!

Before proceeding, make sure your Tinybird token has **"Append"** permission checked (not just "Read"). You need Append to write data.

## Step 1: Copy Your Tinybird Token

1. In Tinybird UI, find your token (token_435008 or the name you gave it)
2. Click on it or look for a "Copy" or "Show" button
3. Copy the token (it starts with `p.`)
4. **Save it somewhere safe** - you'll need it in the next step

## Step 2: Provision Token via Backend

Use the Tinybird token you just copied to provision tokens through your backend:

```bash
curl -X POST http://localhost:3000/api/v1/auth/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "352581d7-e057-4f46-b013-1945b5bd2e07",
    "projectId": "d26cfc86-cf9f-426f-bfb7-e2a1b0f6b6ba",
    "environment": "dev",
    "tinybirdToken": "p.PASTE-YOUR-TINYBIRD-TOKEN-HERE"
  }'
```

**Replace `p.PASTE-YOUR-TINYBIRD-TOKEN-HERE` with the actual token you copied!**

This will:

- Store the Tinybird token mapped to your tenant
- Generate a JWT API key for your SDK
- Return the API key you'll use with the SDK

## Step 3: Test with SDK

After provisioning, you'll get an `apiKey` in the response. Use it:

```bash
export OBSERVA_API_KEY="api-key-from-step-2-response"
export OBSERVA_API_URL="http://localhost:3000"
node ../test-sdk.js
```

## Step 4: Verify Data in Tinybird

1. Go back to Tinybird UI
2. Navigate to your `traces` datasource
3. Click on "Data" tab
4. You should see your traces appearing!

Or run a query:

```sql
SELECT * FROM traces
WHERE tenant_id = '352581d7-e057-4f46-b013-1945b5bd2e07'
ORDER BY timestamp DESC
LIMIT 10
```

