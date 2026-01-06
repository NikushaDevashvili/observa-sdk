# Quick Guide: Create Tenant-Scoped Token

Based on the Tinybird UI you're seeing:

## Simple Steps:

1. **Enable "DATA SOURCES SCOPES"**
   - Check the ✅ "Enabled" checkbox

2. **Click "Add Data Source scope"**

3. **Select your datasource** (`traces`)

4. **Add SQL condition** (if there's a text field for conditions):
   ```
   tenant_id = 'YOUR-TENANT-ID-HERE'
   ```

5. **Set token name**: `tenant-{your-tenant-id}`

6. **Save and copy the token**

## Get Your Tenant ID First

If you don't have a tenant ID yet, create one:

```bash
cd backend
./test-api.sh
```

This will output a tenant ID like: `f8f9b1af-eeae-43c9-bdd2-1de56da2da75`

## Note

Some Tinybird UIs may not show SQL condition fields directly. In that case:

- The token might scope to the entire datasource
- You can still use tenant_id filtering in queries
- Or use Tinybird CLI for advanced scoping (see CREATE_TENANT_TOKEN.md)

## After Creating Token

Use it to provision tokens via your backend API (see NEXT_STEPS.md)





