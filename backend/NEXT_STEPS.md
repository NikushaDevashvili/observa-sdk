# 🎉 Datasource Created! Next Steps

## Current Status
✅ Tinybird datasource created: `schema_ds_4597` (or whatever name it shows in your UI)

## Next Steps

### 1. Note the Datasource Name

Your datasource might be named differently than "traces". 

**Option A**: If you want to rename it to "traces" (optional):
- Click on the datasource name in Tinybird UI
- Look for rename/edit options

**Option B**: Update backend to use the actual name:
- Set environment variable: `TINYBIRD_DATASOURCE_NAME=schema_ds_4597`
- Or update `.env` file in backend directory

### 2. Create Tenant-Scoped Token in Tinybird

For each tenant, you need a Tinybird token with proper scope:

1. Go to **Tokens** in Tinybird UI (left sidebar)
2. Click **"Create Token"** or **"+"**
3. Fill in:
   - **Name**: `tenant-{your-tenant-id}`
   - **Permission**: `Write` (or Read + Write if needed)
   - **Scope**: Add SQL condition:
     ```sql
     tenant_id = '{your-tenant-id}'
     ```
   - Or use the visual scope builder if available
4. Copy the token (starts with `p.`)

### 3. Test End-to-End

**3a. Create Tenant & Project (if not already done):**
```bash
cd backend
./test-api.sh
```
This will give you a tenant ID and project ID.

**3b. Provision Tokens with Real Tinybird Token:**
```bash
curl -X POST http://localhost:3000/api/v1/auth/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR-TENANT-ID-FROM-STEP-3a",
    "projectId": "YOUR-PROJECT-ID-FROM-STEP-3a",
    "environment": "dev",
    "tinybirdToken": "p.your-real-tinybird-token-from-step-2"
  }'
```

**3c. Test SDK with Real Token:**
```bash
# Set the API key from step 3b
export OBSERVA_API_KEY="api-key-returned-from-step-3b"
export OBSERVA_API_URL="http://localhost:3000"

# Run SDK test
node test-sdk.js
```

**3d. Verify Traces in Tinybird:**
- Go back to your datasource in Tinybird UI
- Click on the **"Data"** tab
- You should see traces appearing!
- Or run a query:
  ```sql
  SELECT * FROM schema_ds_4597 
  ORDER BY timestamp DESC 
  LIMIT 10
  ```

## Important Notes

1. **Datasource Name**: Make sure your backend knows the correct datasource name. By default it looks for "traces", but yours might be different.

2. **Tenant Isolation**: Each tenant should have their own Tinybird token scoped to their `tenant_id`. This ensures data isolation.

3. **Token Scope**: The scope `tenant_id = '{tenant-id}'` ensures that tokens can only write data for that specific tenant.

## Troubleshooting

- **No data appearing?** Check backend logs to see if ingestion is working
- **403 errors?** Verify the Tinybird token has correct permissions and scope
- **Wrong datasource name?** Update `TINYBIRD_DATASOURCE_NAME` environment variable

## You're Almost There! 🚀

Once you complete these steps, you'll have a fully working observability pipeline:
SDK → Backend → Tinybird → Data Storage






