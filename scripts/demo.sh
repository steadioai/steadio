#!/usr/bin/env bash
# Run a complete SteadIO demo:
#   1. Start services + demo-seeder via docker compose --profile demo
#   2. Wait for all services to be healthy
#   3. Seed initial demo cost data (no real API keys required)
#   4. Create a demo API key
#   5. Print dashboard URL and sample curl commands

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COST_ENGINE_URL="http://localhost:3002"
PROXY_URL="http://localhost:3001"
DASHBOARD_URL="http://localhost:5173"
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

banner() {
  echo -e "\n${BOLD}${CYAN}$1${RESET}"
}

step() {
  echo -e "  ${GREEN}+${RESET} $1"
}

info() {
  echo -e "  ${YELLOW}>${RESET} $1"
}

# Portable random hex — works without openssl
rand_hex() {
  dd if=/dev/urandom bs=8 count=1 2>/dev/null | od -A n -t x1 | tr -d ' \n' | head -c 16
}

banner "SteadIO - Demo"
echo ""

# ── 1. Start services ────────────────────────────────────────────────────────

banner "Starting services..."
cd "$REPO_ROOT"
docker compose --profile demo up -d --quiet-pull 2>&1 | grep -v "^$" || true
step "Docker Compose started (including demo traffic generator)"

# ── 2. Wait for health ───────────────────────────────────────────────────────

banner "Waiting for services to be healthy..."

wait_for() {
  local name="$1"
  local url="$2"
  local max=30
  local i=0
  while [ $i -lt $max ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      step "$name is healthy"
      return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  echo "ERROR: $name did not become healthy at $url"
  exit 1
}

wait_for "Proxy" "$PROXY_URL/health"
wait_for "Cost Engine" "$COST_ENGINE_URL/health"

# ── 3. Seed initial demo data ────────────────────────────────────────────────

banner "Seeding initial demo data..."

seed_event() {
  local agent_id="$1"
  local team_id="$2"
  local model="$3"
  local provider="$4"
  local input_tokens="$5"
  local output_tokens="$6"

  curl -sf -X POST "$COST_ENGINE_URL/internal/proxy-events" \
    -H "Content-Type: application/json" \
    -d "{
      \"requestId\": \"demo-seed-$(rand_hex)\",
      \"agentId\": \"$agent_id\",
      \"teamId\": \"$team_id\",
      \"workflowId\": \"demo-workflow\",
      \"keyId\": \"demo-key\",
      \"provider\": \"$provider\",
      \"model\": \"$model\",
      \"promptHash\": null,
      \"usage\": {
        \"inputTokens\": $input_tokens,
        \"outputTokens\": $output_tokens,
        \"cacheReadTokens\": 0,
        \"cacheWriteTokens\": 0
      },
      \"toolCalls\": [],
      \"latencyMs\": 450,
      \"streaming\": false,
      \"statusCode\": 200
    }" >/dev/null
}

# Simulate a multi-agent workflow across two teams
seed_event "research-agent"   "acme"    "gpt-4o"            "openai"    2800 640
seed_event "writer-agent"     "acme"    "gpt-4o-mini"       "openai"    1200 980
seed_event "reviewer-agent"   "acme"    "gpt-4o"            "openai"    3200 420
seed_event "planner-agent"    "acme"    "claude-sonnet-4-6" "anthropic" 1800 520
seed_event "research-agent"   "acme"    "gpt-4o"            "openai"    4100 710
seed_event "writer-agent"     "acme"    "gpt-4o-mini"       "openai"    900  1200
seed_event "code-agent"       "startup" "gpt-4o"            "openai"    5600 890
seed_event "test-agent"       "startup" "gpt-4o-mini"       "openai"    1400 630
seed_event "deploy-agent"     "startup" "claude-haiku-4-5"  "anthropic" 800  340
seed_event "code-agent"       "startup" "gpt-4o"            "openai"    7200 1100
seed_event "test-agent"       "startup" "gpt-4o-mini"       "openai"    2100 480
seed_event "monitoring-agent" "startup" "gemini-1.5-flash"  "google"    600  220

step "Seeded 12 historical cost events across 2 teams and 6 agents"

# Set a demo budget
curl -sf -X POST "$COST_ENGINE_URL/api/budgets" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "agent",
    "scopeId": "code-agent",
    "period": "daily",
    "capUsd": 5.00,
    "enforcementMode": "kill"
  }' >/dev/null

step "Created daily budget: code-agent capped at \$5.00/day"

# ── 4. Generate a demo API key ────────────────────────────────────────────────

banner "Generating demo API key..."

KEY_RESP=$(curl -sf -X POST "$COST_ENGINE_URL/api/keys" \
  -H "Content-Type: application/json" \
  -d '{"teamId": "demo", "name": "Demo key"}')

# Extract key value — try python3, fall back to grep+sed
DEMO_KEY=$(echo "$KEY_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null \
  || echo "$KEY_RESP" | grep -o '"key":"[^"]*"' | head -1 | sed 's/"key":"//;s/"//' \
  || true)

if [ -n "$DEMO_KEY" ]; then
  step "API key created: $DEMO_KEY"
else
  DEMO_KEY="el_demo_<see-key-output-above>"
  info "Key creation response: $KEY_RESP"
fi

# ── 5. Print result ──────────────────────────────────────────────────────────

echo ""
banner "Demo ready!"
echo ""
echo -e "  ${BOLD}Dashboard:${RESET}    $DASHBOARD_URL"
echo -e "  ${BOLD}Proxy:${RESET}        $PROXY_URL"
echo -e "  ${BOLD}Cost Engine:${RESET}  $COST_ENGINE_URL"
echo ""
echo -e "  Open the dashboard to see cost breakdown by agent and team."
echo -e "  The demo traffic generator is running — new events appear every 5s."
echo ""
banner "Sample proxy request (pass a real provider API key via Authorization):"
echo ""
echo -e "  ${CYAN}curl $PROXY_URL/openai/chat/completions \\"
echo -e "    -H 'Content-Type: application/json' \\"
echo -e "    -H 'X-SteadIO-Key: $DEMO_KEY' \\"
echo -e "    -H 'X-Agent-Id: my-agent' \\"
echo -e "    -H 'Authorization: Bearer \$OPENAI_API_KEY' \\"
echo -e "    -d '{\"model\": \"gpt-4o-mini\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello!\"}]}'${RESET}"
echo ""
echo -e "  Set a budget cap:"
echo ""
echo -e "  ${CYAN}curl -X POST $COST_ENGINE_URL/api/budgets \\"
echo -e "    -H 'Content-Type: application/json' \\"
echo -e "    -d '{\"scope\": \"agent\", \"scopeId\": \"my-agent\", \"period\": \"daily\", \"capUsd\": 10.00, \"enforcementMode\": \"kill\"}'${RESET}"
echo ""
echo -e "  Stop the demo: ${BOLD}docker compose --profile demo down${RESET}"
echo ""
