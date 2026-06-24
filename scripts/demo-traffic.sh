#!/usr/bin/env sh
# Continuous demo traffic generator.
# Runs inside the demo-seeder container; posts synthetic cost events every few
# seconds so the dashboard live-events feed stays active.

set -eu

COST_ENGINE_URL="${COST_ENGINE_URL:-http://cost-engine:3002}"
INTERVAL="${INTERVAL:-5}"

# Wait until the cost engine is ready (up to 90s)
waited=0
until curl -sf "$COST_ENGINE_URL/health" >/dev/null 2>&1; do
  if [ "$waited" -ge 90 ]; then
    echo "[demo-traffic] cost engine not ready after 90s, exiting"
    exit 1
  fi
  sleep 3
  waited=$((waited + 3))
done

echo "[demo-traffic] cost engine ready — generating synthetic traffic every ${INTERVAL}s"

i=0
while true; do
  i=$((i + 1))

  # Cycle through 8 realistic agent/model combos
  case $((i % 8)) in
    0) agent="research-agent";   team="acme";    model="gpt-4o";            provider="openai";    input=2800; output=640  ;;
    1) agent="writer-agent";     team="acme";    model="gpt-4o-mini";       provider="openai";    input=1200; output=980  ;;
    2) agent="code-agent";       team="startup"; model="gpt-4o";            provider="openai";    input=5600; output=890  ;;
    3) agent="reviewer-agent";   team="acme";    model="claude-sonnet-4-6"; provider="anthropic"; input=3200; output=420  ;;
    4) agent="test-agent";       team="startup"; model="gpt-4o-mini";       provider="openai";    input=1400; output=630  ;;
    5) agent="planner-agent";    team="acme";    model="claude-haiku-4-5";  provider="anthropic"; input=1800; output=520  ;;
    6) agent="monitoring-agent"; team="startup"; model="gemini-1.5-flash";  provider="google";    input=600;  output=220  ;;
    7) agent="deploy-agent";     team="startup"; model="gpt-4o-mini";       provider="openai";    input=900;  output=340  ;;
  esac

  request_id="demo-live-${i}-$(date +%s)"

  curl -sf -X POST "$COST_ENGINE_URL/internal/proxy-events" \
    -H "Content-Type: application/json" \
    -d "{
      \"requestId\": \"${request_id}\",
      \"agentId\": \"${agent}\",
      \"teamId\": \"${team}\",
      \"workflowId\": \"demo-workflow\",
      \"keyId\": \"demo-key\",
      \"provider\": \"${provider}\",
      \"model\": \"${model}\",
      \"promptHash\": null,
      \"usage\": {
        \"inputTokens\": ${input},
        \"outputTokens\": ${output},
        \"cacheReadTokens\": 0,
        \"cacheWriteTokens\": 0
      },
      \"toolCalls\": [],
      \"latencyMs\": 450,
      \"streaming\": false,
      \"statusCode\": 200
    }" >/dev/null 2>&1 || echo "[demo-traffic] event post failed (will retry)"

  sleep "$INTERVAL"
done
