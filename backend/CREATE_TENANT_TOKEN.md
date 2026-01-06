# Creating Tenant-Scoped Token in Tinybird

## Step-by-Step Instructions

### 1. In Tinybird UI, go to Tokens

- Click **"Tokens"** in the left sidebar
- Click **"+"** button or **"Create Token"**

### 2. Enable Data Sources Scopes

- Find the **"DATA SOURCES SCOPES"** section
- Check the **"Enabled"** checkbox
- Click **"Add Data Source scope"** button

### 3. Configure the Scope

When you click "Add Data Source scope", you should see options to:

- Select the datasource (choose `traces` or your datasource name)
- Add SQL condition for tenant scoping

**Add SQL condition:**

```
tenant_id = '{your-tenant-id}'
```

Replace `{your-tenant-id}` with your actual tenant ID from your backend.

**Example:**

```
tenant_id = 'f8f9b1af-eeae-43c9-bdd2-1de56da2da75'
```

### 4. Set Token Name

- Give it a descriptive name like: `tenant-{tenant-id}` or `tenant-acme-corp`

### 5. Save and Copy Token

- Click **"Create"** or **"Save"**
- Copy the token (it starts with `p.`)
- **Important**: Copy it immediately as you may not be able to see it again!

## Alternative: Using Tinybird CLI

If the UI doesn't support SQL conditions directly, you can use the CLI:

```bash
tb token create \
  --name "tenant-{tenant-id}" \
  --permission write \
  --scope "tenant_id = '{tenant-id}'"
```

## Verify Token Scope

To verify the token is scoped correctly:

1. Test writing data with the token
2. Try writing data with `tenant_id = 'different-tenant'`
3. It should fail if scoping is working correctly

## Use the Token

Once you have the token, provision it via your backend:

```bash
curl -X POST http://localhost:3000/api/v1/auth/tokens \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "your-tenant-id",
    "projectId": "your-project-id",
    "environment": "dev",
    "tinybirdToken": "p.your-tinybird-token-here"
  }'
```

The backend will:

1. Store the Tinybird token mapped to your tenant
2. Generate a JWT API key for your SDK
3. When SDK sends traces, backend will use the scoped token to write to Tinybird




