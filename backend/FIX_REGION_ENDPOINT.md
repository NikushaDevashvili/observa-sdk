# Fix Tinybird Region Endpoint Issue

## The Problem

Your token is for `gcp-europe-west2` region, but `api.tinybird.co` defaults to `eu_shared`.

## Solution: Find Your Region-Specific Endpoint

Tinybird provides region-specific API endpoints. You need to find the correct one for `gcp-europe-west2`.

### Option 1: Check Tinybird UI

1. Go to Tinybird UI → Settings or Account settings
2. Look for "API Endpoint" or "Region" settings
3. Find the endpoint URL for your region

### Option 2: Use Your Workspace URL

Tinybird might use your workspace-specific URL. Check:

- Your Tinybird UI URL (e.g., `https://ui.tinybird.co` or workspace-specific)
- The API endpoint might be similar to your workspace URL

### Option 3: Try Common Patterns

Try these endpoint formats (one might work):

```bash
# Pattern 1: Region subdomain
https://gcp-europe-west2.api.tinybird.co

# Pattern 2: Region prefix
https://api-gcp-europe-west2.tinybird.co

# Pattern 3: Keep standard (sometimes works)
https://api.tinybird.co
```

### Option 4: Contact Tinybird Support

If none work, contact Tinybird support to get the correct API endpoint for your region.

## Once You Have the Endpoint

Update your backend:

```bash
cd backend

# Set the correct endpoint
export TINYBIRD_HOST="https://YOUR-REGION-SPECIFIC-ENDPOINT"

# Restart backend
npm run dev
```

Or create a `.env` file:

```
TINYBIRD_HOST=https://YOUR-REGION-SPECIFIC-ENDPOINT
```

## Quick Test

Once you have the endpoint, test it:

```bash
curl -X POST "https://YOUR-ENDPOINT/v0/events?name=traces&format=ndjson" \
  -H "Authorization: Bearer p.eyJ1IjogImVmNGNjNGFlLTExZDAtNDVhNy1hNTcxLTJiZDg1NWNkZDZkNCIsICJpZCI6ICJiZTgxMjhhOS1jODkzLTQxNTEtYjM1Yy1mOTJiOTVlZjUyMjAiLCAiaG9zdCI6ICJnY3AtZXVyb3BlLXdlc3QyIn0.hUl1g7KczdKmDf7SClKAJujLz5NqQjFK3AfTG5Epk9Q" \
  -H "Content-Type: application/x-ndjson" \
  -d '{"tenant_id":"test","timestamp":"2025-12-27T00:00:00.000Z"}'
```

If it doesn't return a region error, that's the correct endpoint!





