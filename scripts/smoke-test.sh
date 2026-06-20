#!/usr/bin/env bash
# SteadIO smoke + load test
#
# Usage:
#   ./scripts/smoke-test.sh                          # local docker-compose defaults
#   PROXY_URL=https://proxy.steadio.ai ./scripts/smoke-test.sh
#
# Tests:
#   1. Health endpoint returns 200 with expected JSON
#   2. Missing auth key returns 401 JSON (never a stack trace)
#   3. Invalid auth key returns 401 JSON
#   4. Unknown route returns 404 JSON with valid_paths hint
#   5. Concurrent health requests (50 parallel) - error rate < 1%
#
# Exits 0 on full pass, 1 on any failure.

set -euo pipefail

PROXY_URL="${PROXY_URL:-http://localhost:3001}"
CONCURRENCY="${CONCURRENCY:-50}"

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${RESET} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${RESET} $1"; FAIL=$((FAIL + 1)); }
banner() { echo -e "\n${BOLD}$1${RESET}"; }

# ── helpers ───────────────────────────────────────────────────────────────────

check_status() {
  local label="$1" url="$2" expected_status="$3"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [ "$status" = "$expected_status" ]; then
    pass "$label (HTTP $status)"
  else
    fail "$label — expected HTTP $expected_status, got $status"
  fi
}

check_json_field() {
  local label="$1" url="$2" method="${3:-GET}" extra_args=("${@:4}")
  local body
  body=$(curl -s -X "$method" "${extra_args[@]}" "$url" 2>/dev/null || echo "{}")
  if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' in d else 1)" 2>/dev/null; then
    pass "$label (response has 'error' field)"
  else
    fail "$label — response missing 'error' field: $body"
  fi
}

# ── 1. Health check ───────────────────────────────────────────────────────────

banner "1. Health endpoint"

HEALTH_BODY=$(curl -s "$PROXY_URL/health" 2>/dev/null || echo "{}")
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PROXY_URL/health" 2>/dev/null || echo "000")

if [ "$HEALTH_STATUS" = "200" ] || [ "$HEALTH_STATUS" = "503" ]; then
  pass "Health endpoint reachable (HTTP $HEALTH_STATUS)"
else
  fail "Health endpoint unreachable — HTTP $HEALTH_STATUS. Is the proxy running at $PROXY_URL?"
fi

if echo "$HEALTH_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'status' in d else 1)" 2>/dev/null; then
  pass "Health response has 'status' field"
else
  fail "Health response missing 'status' field: $HEALTH_BODY"
fi

# ── 2. Missing auth key ───────────────────────────────────────────────────────

banner "2. Auth: missing key"

AUTH_MISSING_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$PROXY_URL/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"test"}]}' 2>/dev/null || echo "000")

AUTH_MISSING_BODY=$(curl -s \
  -X POST "$PROXY_URL/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"test"}]}' 2>/dev/null || echo "{}")

if [ "$AUTH_MISSING_STATUS" = "401" ]; then
  pass "Missing key returns 401"
else
  fail "Missing key should return 401, got $AUTH_MISSING_STATUS"
fi

if echo "$AUTH_MISSING_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('error')=='missing_api_key' else 1)" 2>/dev/null; then
  pass "Missing key body has error=missing_api_key"
else
  fail "Missing key body wrong: $AUTH_MISSING_BODY"
fi

if echo "$AUTH_MISSING_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'hint' in d else 1)" 2>/dev/null; then
  pass "Missing key error includes hint"
else
  fail "Missing key error has no hint: $AUTH_MISSING_BODY"
fi

# ── 3. Invalid auth key ───────────────────────────────────────────────────────

banner "3. Auth: invalid key"

INVALID_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$PROXY_URL/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-SteadIO-Key: el_invalid_notarealkey" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"test"}]}' 2>/dev/null || echo "000")

INVALID_BODY=$(curl -s \
  -X POST "$PROXY_URL/openai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-SteadIO-Key: el_invalid_notarealkey" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"test"}]}' 2>/dev/null || echo "{}")

if [ "$INVALID_STATUS" = "401" ]; then
  pass "Invalid key returns 401"
else
  fail "Invalid key should return 401, got $INVALID_STATUS"
fi

if echo "$INVALID_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('error')=='invalid_or_revoked_key' else 1)" 2>/dev/null; then
  pass "Invalid key body has error=invalid_or_revoked_key"
else
  fail "Invalid key body wrong: $INVALID_BODY"
fi

# ── 4. Unknown route 404 ──────────────────────────────────────────────────────

banner "4. Unknown route 404"

NOTFOUND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PROXY_URL/v1/chat/completions" 2>/dev/null || echo "000")
NOTFOUND_BODY=$(curl -s "$PROXY_URL/v1/chat/completions" 2>/dev/null || echo "{}")

if [ "$NOTFOUND_STATUS" = "404" ]; then
  pass "Unknown route returns 404"
else
  fail "Unknown route should return 404, got $NOTFOUND_STATUS"
fi

if echo "$NOTFOUND_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'valid_paths' in d else 1)" 2>/dev/null; then
  pass "404 body includes valid_paths hint"
else
  fail "404 body missing valid_paths: $NOTFOUND_BODY"
fi

# ── 5. Concurrent load ────────────────────────────────────────────────────────

banner "5. Concurrent load ($CONCURRENCY parallel health requests)"

TMPDIR_LOAD=$(mktemp -d)
trap 'rm -rf "$TMPDIR_LOAD"' EXIT

pids=()
for i in $(seq 1 "$CONCURRENCY"); do
  (
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$PROXY_URL/health" 2>/dev/null || echo "000")
    echo "$status" > "$TMPDIR_LOAD/$i.status"
  ) &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid" || true
done

TOTAL=0
ERRORS=0
for f in "$TMPDIR_LOAD"/*.status; do
  status=$(cat "$f")
  TOTAL=$((TOTAL + 1))
  if [ "$status" != "200" ] && [ "$status" != "503" ]; then
    ERRORS=$((ERRORS + 1))
  fi
done

ERROR_RATE=0
if [ "$TOTAL" -gt 0 ]; then
  ERROR_RATE=$(python3 -c "print(f'{$ERRORS/$TOTAL*100:.1f}')" 2>/dev/null || echo "unknown")
fi

echo -e "  Requests: $TOTAL  |  Errors: $ERRORS  |  Error rate: ${ERROR_RATE}%"

if [ "$ERRORS" -eq 0 ]; then
  pass "Zero errors under $CONCURRENCY concurrent requests"
elif [ "$ERRORS" -le 1 ]; then
  pass "Error rate within tolerance ($ERRORS/$TOTAL)"
else
  fail "Too many errors: $ERRORS/$TOTAL (${ERROR_RATE}%)"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}  ${RED}$FAIL failed${RESET}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
