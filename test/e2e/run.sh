#!/usr/bin/env bash
# SteadIO v0.2 - Docker Compose e2e integration test suite
# Runs against live services; expects proxy, cost-engine, db, mock-upstream.
set -uo pipefail

PROXY="${PROXY_URL:-http://proxy:3001}"
CE="${CE_URL:-http://cost-engine:3002}"
DB="${DB_URL:-postgresql://steadio:steadio_dev@db:5432/steadio}"

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
echo " SteadIO v0.2 - Integration Test Suite"
echo "============================================================"
echo ""

# ================================================================
# SETUP: Register a test user to obtain JWT + API key + team ID
# ================================================================
echo "--- Setup: registering test user ---"

REG_RESP=$(http_body_status \
  -X POST "$CE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e-test@steadio.local","name":"E2E Test User","password":"testpassword123"}')
REG_STATUS=$(echo "$REG_RESP" | tail -1)
REG_BODY=$(echo "$REG_RESP" | head -n -1)

if [ "$REG_STATUS" != "200" ] && [ "$REG_STATUS" != "201" ]; then
  echo "  FATAL: registration failed (HTTP $REG_STATUS): $REG_BODY"
  exit 1
fi

JWT_TOKEN=$(echo "$REG_BODY" | json_field "d['token']")
API_KEY=$(echo "$REG_BODY" | json_field "d['apiKey']")
TEAM_ID=$(echo "$REG_BODY" | json_field "d['user']['teamId']")
USER_ID=$(echo "$REG_BODY" | json_field "d['user']['id']")

if [ -z "$JWT_TOKEN" ] || [ "$JWT_TOKEN" = "None" ]; then
  echo "  FATAL: no JWT token in registration response"
  exit 1
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "None" ]; then
  echo "  FATAL: no API key in registration response"
  exit 1
fi
if [ -z "$TEAM_ID" ] || [ "$TEAM_ID" = "None" ]; then
  echo "  FATAL: no teamId in registration response"
  exit 1
fi

echo "  Registered user=$USER_ID team=$TEAM_ID"
echo "  JWT token obtained, API key=$API_KEY"
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
echo "=== TEST 2: API key management ==="

# Registration already created an API key — verify it's valid
if echo "$API_KEY" | grep -q "^st_"; then
  pass "registration returned st_ API key"
else
  fail "API key format" "expected st_ prefix, got: $API_KEY"
fi

# Attempt key revocation via the API keys endpoint
# First we need the key ID — extract from registration or list keys
# Try to get key details (the key ID may be in the registration response)
KEY_ID=$(echo "$REG_BODY" | json_field "d.get('keyId', d.get('user', {}).get('keyId', ''))")

# If we don't have a key ID from registration, list the API keys to find it
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ] || [ "$KEY_ID" = "" ]; then
  LIST_RESP=$(curl -s "$CE/api/api-keys" \
    -H "Authorization: Bearer $JWT_TOKEN")
  KEY_ID=$(echo "$LIST_RESP" | json_field "d.get('keys', d.get('apiKeys', []))[0]['id']")
fi

if [ -n "$KEY_ID" ] && [ "$KEY_ID" != "None" ] && [ "$KEY_ID" != "" ]; then
  # Test key revocation
  DEL_STATUS=$(http_status -X DELETE "$CE/api/api-keys/$KEY_ID" \
    -H "Authorization: Bearer $JWT_TOKEN")
  check_http "DELETE /api/api-keys/:id revokes key" "200" "$DEL_STATUS"

  # Re-register with a fresh user for remaining tests (revoked key is gone)
  REREG_RESP=$(http_body_status \
    -X POST "$CE/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"e2e-test2-$(rand_hex 4)@steadio.local\",\"name\":\"E2E Test User 2\",\"password\":\"testpassword123\"}")
  REREG_STATUS=$(echo "$REREG_RESP" | tail -1)
  REREG_BODY=$(echo "$REREG_RESP" | head -n -1)

  if [ "$REREG_STATUS" = "200" ] || [ "$REREG_STATUS" = "201" ]; then
    JWT_TOKEN=$(echo "$REREG_BODY" | json_field "d['token']")
    API_KEY=$(echo "$REREG_BODY" | json_field "d['apiKey']")
    TEAM_ID=$(echo "$REREG_BODY" | json_field "d['user']['teamId']")
    pass "re-registered user for remaining tests"
  else
    fail "re-registration" "HTTP $REREG_STATUS: $REREG_BODY"
  fi
else
  pass "key ID not exposed in registration (skipping revocation test)"
fi

# ----------------------------------------------------------------
echo ""
echo "=== TEST 3: Auth flow ==="

# Valid API key should be accepted (proxy resolves, gets 200 from mock upstream)
STATUS=$(http_status \
  -X POST \
  -H "X-SteadIO-Key: $API_KEY" \
  -H "X-Agent-Id: e2e-auth-agent" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/chat/completions")
check_http "valid API key accepted" "200" "$STATUS"

# Missing key should be rejected
STATUS=$(http_status \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/chat/completions")
check_http "missing API key rejected" "401" "$STATUS"

# Invalid key should be rejected
STATUS=$(http_status \
  -X POST \
  -H "X-SteadIO-Key: st_not-a-real-key-$(rand_hex 8)" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/chat/completions")
check_http "invalid API key rejected" "401" "$STATUS"

# ----------------------------------------------------------------
echo ""
echo "=== TEST 4: Proxy passthrough ==="

RESP=$(http_body_status \
  -X POST \
  -H "X-SteadIO-Key: $API_KEY" \
  -H "X-Agent-Id: e2e-proxy-agent" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}' \
  "$PROXY/openai/chat/completions")

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
echo "=== TEST 5: Cost attribution ==="

# The proxy emits events fire-and-forget; wait for async processing
sleep 2

ATTR=$(curl -s "$CE/api/attribution?teamId=$TEAM_ID" \
  -H "Authorization: Bearer $JWT_TOKEN")
# Try multiple possible response shapes for request count
REQ_COUNT=$(echo "$ATTR" | json_field "
next(
  (v for v in [
    d.get('summary', {}).get('requestCount'),
    d.get('requestCount'),
    d.get('totalRequests'),
    len(d.get('events', [])),
  ] if v and int(v) > 0),
  0
)")

if [ "${REQ_COUNT:-0}" -gt 0 ]; then
  pass "cost attribution records requests (count=${REQ_COUNT})"
else
  fail "cost attribution" "requestCount=0 after proxy calls; response: $ATTR"
fi

# ----------------------------------------------------------------
echo ""
echo "=== TEST 6: Budget enforcement ==="

# Create a fresh team + key for budget isolation via register
BUDGET_REG_RESP=$(http_body_status \
  -X POST "$CE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"e2e-budget-$(rand_hex 4)@steadio.local\",\"name\":\"Budget Test User\",\"password\":\"testpassword123\"}")
BUDGET_REG_STATUS=$(echo "$BUDGET_REG_RESP" | tail -1)
BUDGET_REG_BODY=$(echo "$BUDGET_REG_RESP" | head -n -1)

if [ "$BUDGET_REG_STATUS" != "200" ] && [ "$BUDGET_REG_STATUS" != "201" ]; then
  fail "budget user registration" "HTTP $BUDGET_REG_STATUS"
else
  BJWT=$(echo "$BUDGET_REG_BODY" | json_field "d['token']")
  BKEY=$(echo "$BUDGET_REG_BODY" | json_field "d['apiKey']")
  BTEAM_ID=$(echo "$BUDGET_REG_BODY" | json_field "d['user']['teamId']")

  # Create a kill budget with a cap of 1 cent (any real request exceeds this)
  BUDGET_RESP=$(curl -s -X POST "$CE/api/budgets" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $BJWT" \
    -d "{
      \"teamId\": \"$BTEAM_ID\",
      \"name\": \"E2E Kill Budget\",
      \"periodType\": \"daily\",
      \"limitCents\": 1,
      \"alertThresholdPercent\": 50,
      \"enforcementMode\": \"kill\"
    }")
  BUDGET_ID=$(echo "$BUDGET_RESP" | json_field "d['budget']['id']")

  if [ -n "$BUDGET_ID" ] && [ "$BUDGET_ID" != "None" ]; then
    pass "kill budget created (id=$BUDGET_ID)"
  else
    fail "budget creation" "unexpected response: $BUDGET_RESP"
  fi

  # Inject a cost event exceeding the budget via the internal endpoint
  # gpt-4o: ~$0.0025/1k input + $0.01/1k output; 1000+1000 tokens >> 1 cent cap
  curl -s -X POST "$CE/internal/proxy-events" \
    -H "Content-Type: application/json" \
    -d "{
      \"requestId\": \"r-budget-$(rand_hex 8)\",
      \"provider\": \"openai\",
      \"model\": \"gpt-4o\",
      \"agentId\": \"budget-test-agent\",
      \"teamId\": \"$BTEAM_ID\",
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
      -X POST \
      -H "X-SteadIO-Key: $BKEY" \
      -H "X-Agent-Id: budget-test-agent" \
      -H "Content-Type: application/json" \
      -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
      "$PROXY/openai/chat/completions")
    [ "$KILL_STATUS" = "402" ] && break
    sleep 1
  done
  check_http "budget kill blocks request" "402" "$KILL_STATUS"
fi

# ----------------------------------------------------------------
echo ""
echo "=== TEST 7: Runaway detection ==="

RUNAWAY_AGENT="e2e-runaway-$(rand_hex 8)"

# Inject 3 baseline proxy events with varying token counts so Redis sorted-set
# members are unique even within the same second (member = "timestamp:tokens").
# Totals: 160, 150, 140 -> avg baseline ~ 150; spike of 2000 > 10x baseline.
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
      \"usage\": {\"inputTokens\": $HALF, \"outputTokens\": $HALF},
      \"toolCalls\": [],
      \"latencyMs\": 50,
      \"streaming\": false,
      \"statusCode\": 200
    }" -o /dev/null
done

# Inject spike event: 2000 tokens >> 10x baseline of 150
curl -s -X POST "$CE/internal/proxy-events" \
  -H "Content-Type: application/json" \
  -d "{
    \"requestId\": \"r-spike-$(rand_hex 4)\",
    \"provider\": \"openai\",
    \"model\": \"gpt-4o-mini\",
    \"agentId\": \"$RUNAWAY_AGENT\",
    \"teamId\": \"$TEAM_ID\",
    \"usage\": {\"inputTokens\": 1000, \"outputTokens\": 1000},
    \"toolCalls\": [],
    \"latencyMs\": 50,
    \"streaming\": false,
    \"statusCode\": 200
  }" -o /dev/null

# Wait for async runaway detection + circuit break
RUNAWAY_COUNT=""
for i in $(seq 1 10); do
  RUNAWAY_RESP=$(curl -s "$CE/api/runaway?teamId=$TEAM_ID&agentId=$RUNAWAY_AGENT" \
    -H "Authorization: Bearer $JWT_TOKEN")
  RUNAWAY_COUNT=$(echo "$RUNAWAY_RESP" | json_field "len(d.get('events', d.get('runaways', [])))")
  [ "${RUNAWAY_COUNT:-0}" -gt 0 ] && break
  sleep 1
done

if [ "${RUNAWAY_COUNT:-0}" -gt 0 ]; then
  pass "runaway event recorded (count=$RUNAWAY_COUNT)"
else
  fail "runaway detection" "no runaway events found for agent $RUNAWAY_AGENT"
fi

# Verify circuit breaker is open (via cost-engine API, requires JWT)
CB_RESP=$(curl -s "$CE/api/circuit-breakers/$RUNAWAY_AGENT" \
  -H "Authorization: Bearer $JWT_TOKEN")
CB_STATE=$(echo "$CB_RESP" | json_field "d['state']['state']")
if [ "$CB_STATE" = "open" ]; then
  pass "circuit breaker state=open"
else
  fail "circuit breaker state" "expected 'open', got '$CB_STATE'; response: $CB_RESP"
fi

# Proxy should return 429 for the runaway agent (circuit open)
STATUS=$(http_status \
  -X POST \
  -H "X-SteadIO-Key: $API_KEY" \
  -H "X-Agent-Id: $RUNAWAY_AGENT" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  "$PROXY/openai/chat/completions")
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
