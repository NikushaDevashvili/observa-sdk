# Tinybird Token Setup - Filter Limitation

## The Issue

Tinybird doesn't allow **Append (write) permission** when a token has SQL filters. Filters are read-only.

## Solution Options

### Option 1: Remove SQL Filter (Recommended for MVP)

Create a token **without** the SQL filter, but with Append permission:

1. Go back to your token in Tinybird UI
2. **Remove the SQL filter** (`tenant_id = '...'`)
3. Enable **"Append"** permission for the `traces` datasource
4. This token can write to the datasource

**Why this is OK:**

- Your **backend** still enforces tenant isolation
- The backend always includes `tenant_id` in every trace
- When reading data, you can still filter by `tenant_id`
- For production, you can add additional security layers

### Option 2: Two Tokens (More Secure, More Complex)

- **Token 1**: With SQL filter, Read-only (for queries/dashboards)
- **Token 2**: Without filter, Append permission (for writes via backend)

Use Token 2 for the backend.

## For Now: Use Option 1

**Steps:**

1. Edit your token in Tinybird UI
2. Remove the SQL filter condition
3. Enable "Append" checkbox for `traces` datasource
4. Save the token
5. Copy the token value
6. Use it with the provisioning script

Your backend will still ensure each trace includes the correct `tenant_id`, so data isolation is maintained.

## Data Isolation Still Works

Even without the SQL filter on the token:

- ✅ Backend validates JWT and extracts `tenant_id`
- ✅ Backend includes `tenant_id` in every trace sent to Tinybird
- ✅ All data in Tinybird has the `tenant_id` column
- ✅ Queries can filter by `tenant_id` to show only relevant data
- ✅ Your application layer controls what data goes where

The SQL filter on tokens is an extra security layer, but not required for basic functionality.





