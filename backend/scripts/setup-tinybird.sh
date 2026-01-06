#!/bin/bash

# Setup script to help configure Tinybird for Observa
# This script guides you through the setup process

echo "🔧 Tinybird Setup for Observa"
echo "=============================="
echo ""
echo "This script will help you:"
echo "  1. Create the traces datasource"
echo "  2. Set up tenant-scoped tokens"
echo ""
echo "Prerequisites:"
echo "  - Tinybird account (sign up at https://ui.tinybird.co)"
echo "  - Tinybird admin token (get from Settings > Tokens)"
echo ""

# Check if Tinybird CLI is installed
if command -v tb &> /dev/null; then
    echo "✅ Tinybird CLI found"
    USE_CLI=true
else
    echo "⚠️  Tinybird CLI not found. We'll use the API instead."
    echo "   Install CLI: npm install -g @tinybird/cli (optional)"
    USE_CLI=false
fi

echo ""
read -p "Do you have your Tinybird admin token? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "📝 Get your admin token:"
    echo "  1. Go to https://ui.tinybird.co"
    echo "  2. Navigate to Settings > Tokens"
    echo "  3. Copy your admin token (starts with 'p.')"
    echo ""
    exit 1
fi

echo ""
read -p "Enter your Tinybird admin token: " TINYBIRD_TOKEN

if [ -z "$TINYBIRD_TOKEN" ]; then
    echo "❌ Token is required"
    exit 1
fi

echo ""
echo "📊 Step 1: Creating traces datasource..."
echo ""

# Create datasource schema file
mkdir -p datasources
cat > datasources/traces.datasource << 'EOF'
SCHEMA >
    `tenant_id` String,
    `project_id` String,
    `environment` Enum8('dev' = 1, 'prod' = 2),
    `timestamp` DateTime64(3),
    `date` Date MATERIALIZED toDate(timestamp),
    `trace_id` String,
    `span_id` String,
    `parent_span_id` Nullable(String),
    `query` String,
    `context` Nullable(String),
    `model` Nullable(String),
    `metadata_json` String,
    `response` String,
    `response_length` UInt32,
    `tokens_prompt` Nullable(UInt32),
    `tokens_completion` Nullable(UInt32),
    `tokens_total` Nullable(UInt32),
    `latency_ms` UInt32,
    `ttfb_ms` Nullable(UInt32),
    `streaming_ms` Nullable(UInt32),
    `status` Nullable(UInt16),
    `status_text` Nullable(String),
    `finish_reason` Nullable(String),
    `response_id` Nullable(String),
    `system_fingerprint` Nullable(String),
    `headers_json` String

ENGINE MergeTree
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, timestamp, trace_id)
TTL date + INTERVAL 90 DAY
EOF

if [ "$USE_CLI" = true ]; then
    echo "Using Tinybird CLI to create datasource..."
    export TB_TOKEN=$TINYBIRD_TOKEN
    tb push datasources/traces.datasource
else
    echo "⚠️  Please create the datasource manually:"
    echo ""
    echo "   1. Go to https://ui.tinybird.co"
    echo "   2. Navigate to Data Sources"
    echo "   3. Click 'Create Data Source'"
    echo "   4. Name it 'traces'"
    echo "   5. Copy the schema from: datasources/traces.datasource"
    echo ""
    read -p "Press Enter when datasource is created..."
fi

echo ""
echo "✅ Datasource setup complete!"
echo ""
echo "📝 Next Steps:"
echo ""
echo "  1. For each tenant, create a Tinybird token with scope:"
echo "     tenant_id = 'YOUR-TENANT-ID'"
echo ""
echo "  2. When provisioning tokens via backend API, use the real token:"
echo "     curl -X POST http://localhost:3000/api/v1/auth/tokens \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{"
echo "         \"tenantId\": \"...\","
echo "         \"projectId\": \"...\","
echo "         \"tinybirdToken\": \"p.your-tinybird-token-here\""
echo "       }'"
echo ""
echo "  3. Use the returned apiKey with the SDK"
echo ""
echo "For more details, see: tinybird-setup.md"





