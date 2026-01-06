#!/bin/bash

# Kill any process on port 3000
echo "🔍 Checking port 3000..."
if lsof -ti:3000 > /dev/null 2>&1; then
  echo "⚠️  Port 3000 is in use. Killing existing process..."
  lsof -ti:3000 | xargs kill -9 2>/dev/null
  sleep 1
  echo "✅ Port 3000 cleared"
else
  echo "✅ Port 3000 is available"
fi

# Start the backend
echo ""
echo "🚀 Starting Observa Backend..."
npm run dev





