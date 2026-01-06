#!/bin/bash

# Script to provision tokens with Tinybird token
# Usage: ./provision-token.sh <your-tinybird-token>

if [ -z "$1" ]; then
  echo "❌ Error: Tinybird token required"
  echo ""
  echo "Usage: ./provision-token.sh <your-tinybird-token>"
  echo ""
  echo "Example:"
  echo "  ./provision-token.sh p.your-tinybird-token-here"
  echo ""
  echo "💡 Get your Tinybird token from Tinybird UI (Tokens section)"
  exit 1
fi

TINYBIRD_TOKEN="$1"
BASE_URL="http://localhost:3000"
TENANT_ID="352581d7-e057-4f46-b013-1945b5bd2e07"
PROJECT_ID="d26cfc86-cf9f-426f-bfb7-e2a1b0f6b6ba"

echo "🔑 Provisioning tokens..."
echo ""

RESPONSE=$(curl -s -X POST "$BASE_URL/api/v1/auth/tokens" \
  -H "Content-Type: application/json" \
  -d "{
    \"tenantId\": \"$TENANT_ID\",
    \"projectId\": \"$PROJECT_ID\",
    \"environment\": \"dev\",
    \"tinybirdToken\": \"$TINYBIRD_TOKEN\"
  }")

API_KEY=$(echo "$RESPONSE" | grep -o '"apiKey":"[^"]*' | cut -d'"' -f4)

if [ -z "$API_KEY" ]; then
  echo "❌ Failed to provision tokens"
  echo "   Response: $RESPONSE"
  exit 1
fi

echo "✅ Tokens provisioned successfully!"
echo ""
echo "📝 Your API Key (use this with SDK):"
echo "$API_KEY"
echo ""
echo "💡 To test with SDK:"
echo "   export OBSERVA_API_KEY=\"$API_KEY\""
echo "   export OBSERVA_API_URL=\"http://localhost:3000\""
echo "   cd .. && node test-sdk.js"
echo ""
echo "📊 Then check Tinybird UI to see your traces!"





