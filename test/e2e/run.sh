#!/usr/bin/env bash
# Elevation Networks — Docker Compose e2e integration test suite
# Runs against live services; expects proxy, cost-engine, db, mock-upstream.
set -uo pipefail

PROXY="${PROXY_URL:-http://proxy:3001}"
CE="${CE_URL:-http://cost-engine:3002}"
DB="${DB_URL:-postgresql://elevation:elevation_dev@db:5432/elevation}"

PASSED=0
FAILED=0

pass() { echo "  [PASS] $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  [FAIL] $1 — $2"; FAILED=$((FAILED + 1)); }

# Check HTTP status code; log pass/fail without stopping script
check_http() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label" "expected HTTP $expected, got HTTP $actual"
  fi
}

# Return HTTP status without failing on 4xx/5xx
http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# Return full response body + final line = HTTP status
http_body_status() {
  curl -s -w "\n%{http_code}" "$@"
}

# Extract a JSON field via python (no jq dependency)
json_field() {
  python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null || echo ""
}

# Retry helper: wait up to N seconds for a predicate
wait_for() {
  local label="$1" max="$2"; shift 2
  for i in $(seq 1 "$max"); do
    if "$@" 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "$label" "timed out after ${max}s"
  return 1
}

# Generate a random hex string
rand_hex() { cat /dev/urandom | tr -dc 'a-f0-9' | head -c "${1:-16}"; }

echo "============================================================"
echo " Elevation Networks — Integration Test Suite"
echo "============================================================"
echo ""

# ----------------------------------------------------------------
echo "=== TEST 1: Health checks ==="

STATUS=$(http_status "$PROXY/health")
check_http "proxy /health" "200" "$STATUS"

STATUS=$(http_status "$CE/health")
check_http "cost-engine /health" "200" "$STATUS"

CE_HEALTH=$(curl -s "$CE/health")
CE_STATUS=$(echo "$CE_HEALTH" | json_field "d['status']")
if [ "$CE_STATUS" = "ok" ]; then
  pass "cost-engine reports status=ok"
else
  fail "cost-engine status field" "expected 'ok', got '$CE_STATUS'"
fi

# ----------------------------------------------------------------
echo ""
echo "=== TEST 2: Auth flow ==="

# Seed a team and API key directly via psql
TEAM_ID="e2e-$(rand_hex 8)"
API_KEY="sk-e2e-$(rand_hex 32)"
KEY_HASH=$(echo -n "$API_KEY" | sha256sum | awk '{print $1}')
KEY_ID="k-$(rand_hex 8)"

psql "$DB" -q -c \
  "INSERT INTO teams (id, name) VALUES ('$TEAM_ID', 'E2E Test Team');"

psql "$DB" -q -c \
  "INSERT INTO api_keys (id, key_hash, team_id, name)
   VALUES ('$KEY_ID', '$KEY_HASH', '$TEAM_ID', 'E2E Key');"

pass "team and API key seeded in database"

# Valid key should be accepted (proxy resolves, gets 200 from mock upstream)
STATUS=$(http_status \
  -H "X-Elevation-Key: $API_KEY" \
  -H "X-Agent-Id: e2e-auth-agent" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/v1/chat/completions")
check_http "valid API key accepted" "200" "$STATUS"

# Missing key should be rejected
STATUS=$(http_status \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/v1/chat/completions")
check_http "missing API key rejected" "401" "$STATUS"

# Invalid key should be rejected
STATUS=$(http_status \
  -H "X-Elevation-Key: sk-not-a-real-key-$(rand_hex 8)" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/v1/chat/completions")
check_http "invalid API key rejected" "401" "$STATUS"

# ----------------------------------------------------------------
echo ""
echo "=== TEST 3: Proxy passthrough ==="

RESP=$(http_body_status \
  -X POST \
  -H "X-Elevation-Key: $API_KEY" \
  -H "X-Agent-Id: e2e-proxy-agent" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/v1/chat/completions")

STATUS=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)

check_http "proxy passthrough returns 200" "200" "$STATUS"

# Verify the response has OpenAI-shaped choices from the mock
CHOICES_LEN=$(echo "$BODY" | json_field "len(d.get('choices', []))")
if [ "${CHOICES_LEN:-0}" -gt 0 ]; then
  pass "proxy response contains choices"
else
  fail "proxy response choices" "empty or missing choices in: $BODY"
fi

# ----------------------------------------------------------------
echo ""
echo "=== TEST 4: Cost attribution ==="

# The proxy emits events fire-and-forget; wait for async processing
sleep 2

ATTR=$(curl -s "$CE/api/attribution/summary")
REQ_COUNT=$(echo "$ATTR" | json_field "int(d['summary']['requestCount'])")
if [ "${REQ_COUNT:-0}" -gt 0 ]; then
  pass "cost attribution records requests (count=${REQ_COUNT})"
else
  fail "cost attribution" "requestCount=0 after proxy calls; response: $ATTR"
fi

# ----------------------------------------------------------------
echo ""
echo "=== TEST 5: Budget enforcement ==="

# Create a fresh team + key for budget isolation
BTEAM_ID="e2e-bt-$(rand_hex 8)"
BKEY="sk-budget-$(rand_hex 32)"
BKEY_HASH=$(echo -n "$BKEY" | sha256sum | awk '{print $1}')
BKEY_ID="bk-$(rand_hex 8)"

psql "$DB" -q -c \
  "INSERT INTO teams (id, name) VALUES ('$BTEAM_ID', 'Budget Test Team');"
psql "$DB" -q -c \
  "INSERT INTO api_keys (id, key_hash, team_id, name)
   VALUES ('$BKEY_ID', '$BKEY_HASH', '$BTEAM_ID', 'Budget Key');"

# Create a kill budget with a cap of $0.000001 (any real request exceeds this)
BUDGET_RESP=$(curl -s -X POST "$CE/api/budgets" \
  -H "Content-Type: application/json" \
  -d "{
    \"scope\": \"team\",
    \"scopeId\": \"$BTEAM_ID\",
    \"period\": \"daily\",
    \"capUsd\": 0.000001,
    \"warningThresholdPercent\": 50,
    \"enforcementMode\": \"kill\"
  }")
BUDGET_ID=$(echo "$BUDGET_RESP" | json_field "d['budget']['id']")

if [ -n "$BUDGET_ID" ] && [ "$BUDGET_ID" != "None" ]; then
  pass "kill budget created (id=$BUDGET_ID)"
else
  fail "budget creation" "unexpected response: $BUDGET_RESP"
fi

# Inject a cost event exceeding the budget via the internal endpoint
# gpt-4o: ~$0.0025/1k input + $0.01/1k output; 1000+1000 tokens >> $0.000001 cap
curl -s -X POST "$CE/internal/proxy-events" \
  -H "Content-Type: application/json" \
  -d "{
    \"requestId\": \"r-budget-$(rand_hex 8)\",
    \"provider\": \"openai\",
    \"model\": \"gpt-4o\",
    \"agentId\": \"budget-test-agent\",
    \"teamId\": \"$BTEAM_ID\",
    \"workflowId\": null,
    \"usage\": {\"inputTokens\": 1000, \"outputTokens\": 1000},
    \"toolCalls\": [],
    \"latencyMs\": 100,
    \"streaming\": false,
    \"statusCode\": 200
  }" -o /dev/null

# Wait for async budget enforcement (kill key written to Redis)
# Retry for up to 10 seconds to avoid timing flakes
KILL_STATUS=""
for i in $(seq 1 10); do
  KILL_STATUS=$(http_status \
    -H "X-Elevation-Key: $BKEY" \
    -H "X-Agent-Id: budget-test-agent" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
    "$PROXY/openai/v1/chat/completions")
  [ "$KILL_STATUS" = "402" ] && break
  sleep 1
done
check_http "budget kill blocks request" "402" "$KILL_STATUS"

# ----------------------------------------------------------------
echo ""
echo "=== TEST 6: Runaway detection ==="

RUNAWAY_AGENT="e2e-runaway-$(rand_hex 8)"

# Inject 3 baseline proxy events with varying token counts so Redis sorted-set
# members are unique even within the same second (member = "timestamp:tokens").
# Totals: 160, 150, 140 → avg baseline ≈ 150; spike of 2000 > 10× baseline.
declare -a BASE_TOKENS=(160 150 140)
for i in 0 1 2; do
  TOKENS="${BASE_TOKENS[$i]}"
  HALF=$((TOKENS / 2))
  curl -s -X POST "$CE/internal/proxy-events" \
    -H "Content-Type: application/json" \
    -d "{
      \"requestId\": \"r-base-$i-$(rand_hex 4)\",
      \"provider\": \"openai\",
      \"model\": \"gpt-4o-mini\",
      \"agentId\": \"$RUNAWAY_AGENT\",
      \"teamId\": \"$TEAM_ID\",
      \"workflowId\": null,
      \"usage\": {\"inputTokens\": $HALF, \"outputTokens\": $HALF},
      \"toolCalls\": [],
      \"latencyMs\": 50,
      \"streaming\": false,
      \"statusCode\": 200
    }" -o /dev/null
done

# Inject spike event: 2000 tokens >> 10× baseline of 150
curl -s -X POST "$CE/internal/proxy-events" \
  -H "Content-Type: application/json" \
  -d "{
    \"requestId\": \"r-spike-$(rand_hex 4)\",
    \"provider\": \"openai\",
    \"model\": \"gpt-4o-mini\",
    \"agentId\": \"$RUNAWAY_AGENT\",
    \"teamId\": \"$TEAM_ID\",
    \"workflowId\": null,
    \"usage\": {\"inputTokens\": 1000, \"outputTokens\": 1000},
    \"toolCalls\": [],
    \"latencyMs\": 50,
    \"streaming\": false,
    \"statusCode\": 200
  }" -o /dev/null

# Wait for async runaway detection + circuit break
RUNAWAY_COUNT=""
for i in $(seq 1 10); do
  RUNAWAY_RESP=$(curl -s "$CE/api/runaways?agentId=$RUNAWAY_AGENT")
  RUNAWAY_COUNT=$(echo "$RUNAWAY_RESP" | json_field "len(d.get('runaways', []))")
  [ "${RUNAWAY_COUNT:-0}" -gt 0 ] && break
  sleep 1
done

if [ "${RUNAWAY_COUNT:-0}" -gt 0 ]; then
  pass "runaway event recorded (count=$RUNAWAY_COUNT)"
else
  fail "runaway detection" "no runaway events found for agent $RUNAWAY_AGENT"
fi

# Verify circuit breaker is open in Redis (via cost-engine API)
CB_RESP=$(curl -s "$CE/api/circuit-breakers/$RUNAWAY_AGENT")
CB_STATE=$(echo "$CB_RESP" | json_field "d['state']['state']")
if [ "$CB_STATE" = "open" ]; then
  pass "circuit breaker state=open"
else
  fail "circuit breaker state" "expected 'open', got '$CB_STATE'; response: $CB_RESP"
fi

# Proxy should return 429 for the runaway agent (circuit open)
STATUS=$(http_status \
  -H "X-Elevation-Key: $API_KEY" \
  -H "X-Agent-Id: $RUNAWAY_AGENT" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  "$PROXY/openai/v1/chat/completions")
check_http "circuit breaker blocks runaway agent" "429" "$STATUS"

# ----------------------------------------------------------------
echo ""
echo "============================================================"
echo " Results: $PASSED passed, $FAILED failed"
echo "============================================================"

if [ "$FAILED" -gt 0 ]; then
  echo "INTEGRATION TESTS FAILED"
  exit 1
fi
echo "All integration tests passed!"
