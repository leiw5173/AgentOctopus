#!/bin/bash
# Test script for OpenClaw integration

echo "=== AgentOctopus OpenClaw Integration Test ==="
echo ""

# Load environment variables
export $(cat .env | xargs)

# Start the gateway in background
echo "Starting agent gateway on port 3002..."
node packages/gateway/dist/bin/start-agent-gateway.js &
GATEWAY_PID=$!

# Wait for server to start
sleep 3

echo ""
echo "=== Test 1: Health Check ==="
curl -s http://localhost:3002/agent/health
echo ""

echo ""
echo "=== Test 2: Weather Query (skill routing) ==="
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is the weather in Tokyo", "agentId": "openclaw-test"}'
echo ""

echo ""
echo "=== Test 3: Translation Query (skill routing) ==="
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "translate hello to French", "agentId": "openclaw-test"}'
echo ""

echo ""
echo "=== Test 4: Direct Answer (no skill match) ==="
curl -s -X POST http://localhost:3002/agent/ask \
  -H 'Content-Type: application/json' \
  -d '{"query": "what is 2+2", "agentId": "openclaw-test"}'
echo ""

echo ""
echo "=== Test 5: Feedback ==="
curl -s -X POST http://localhost:3002/agent/feedback \
  -H 'Content-Type: application/json' \
  -d '{"skillName": "weather", "positive": true}'
echo ""

# Cleanup
echo ""
echo "Stopping gateway..."
kill $GATEWAY_PID

echo ""
echo "=== Tests Complete ==="
