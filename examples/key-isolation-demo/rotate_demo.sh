#!/usr/bin/env bash
# rotate_demo.sh
#
# The honest follow-up to run_demo.sh. Architecture B still leaked a gateway
# token to the compromised dependency. This script shows why that is a
# recoverable loss and an in-process provider key is not: the operator rotates
# the token centrally, and the attacker's stolen copy stops working while the
# legitimate app keeps running. No restart, no redeploy of the app.
#
# Stdlib only, no external services. Same isolation discipline as run_demo.sh.
set -euo pipefail
cd "$(dirname "$0")"

PROVIDER_API_KEY="sk-provider-REALSECRET-abc123xyz"
TOKEN_V1="gw-app-token-v1-STOLEN-by-attacker-789"
TOKEN_V2="gw-app-token-v2-rotated-clean-abc456"
# Ask the OS for a free port so the demo never collides with something already
# listening. Falls back to 8722 if that lookup fails.
PROXY_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 8722)"
TOKENS_FILE="$(mktemp)"

line() { printf '%s\n' "------------------------------------------------------------"; }
DEMO_PATH="$PATH"
HERE="$(pwd)"
run_clean() { env -i PATH="$DEMO_PATH" PYTHONPATH="$HERE" "$@"; }

# Helper: make a raw call to the proxy with a given token, printing the proxy's verdict.
call_with() {
  local who="$1" token="$2"
  run_clean GATEWAY_TOKEN="$token" PROXY_PORT="$PROXY_PORT" python3 - "$who" <<'PY'
import os, sys, json, urllib.request, urllib.error
who = sys.argv[1]
token = os.environ["GATEWAY_TOKEN"]
port = os.environ["PROXY_PORT"]
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/",
    data=json.dumps({"prompt": "ping"}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read().decode())
    print(f"  [{who}] ACCEPTED -> completion ok, upstream key {body['upstream_key_used']}")
except urllib.error.HTTPError as exc:
    print(f"  [{who}] BLOCKED  -> HTTP {exc.code} {exc.read().decode()}")
PY
}

# Start the proxy. Token store begins with only v1 active, scoped to one route.
cat > "$TOKENS_FILE" <<JSON
{ "$TOKEN_V1": { "scope": "chat:completions", "active": true } }
JSON
run_clean PROVIDER_API_KEY="$PROVIDER_API_KEY" TOKENS_FILE="$TOKENS_FILE" PROXY_PORT="$PROXY_PORT" \
  python3 proxy_server.py &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true; rm -f "$TOKENS_FILE"' EXIT
for _ in 1 2 3 4 5 10 20; do
  if python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',$PROXY_PORT))==0 else 1)" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

line
echo "STEP 1  Normal operation. The app calls with token v1."
line
call_with "app (v1)" "$TOKEN_V1"
echo

line
echo "STEP 2  Compromise. The malicious dependency stole token v1 from the app"
echo "        environment. The attacker now replays it from their own machine."
line
call_with "attacker (stolen v1)" "$TOKEN_V1"
echo "        At this moment both the app and the attacker can call. This is the"
echo "        leaked-token window the demo is honest about."
echo

line
echo "STEP 3  Rotate. The operator revokes v1 and issues v2 by editing the token"
echo "        store. No app restart, no redeploy. The proxy re-reads it live."
line
cat > "$TOKENS_FILE" <<JSON
{
  "$TOKEN_V1": { "scope": "chat:completions", "active": false },
  "$TOKEN_V2": { "scope": "chat:completions", "active": true }
}
JSON
echo "        token store updated: v1 active=false, v2 active=true"
echo

line
echo "STEP 4  After rotation. The attacker's stolen v1 is dead. The app, given"
echo "        its new v2 token, keeps working."
line
call_with "attacker (stolen v1)" "$TOKEN_V1"
call_with "app (v2)" "$TOKEN_V2"
echo

line
echo "STEP 5  Scoping. Even a live token only opens the route it is scoped to."
echo "        A token for a different scope is refused, so a leaked token cannot"
echo "        be widened into general provider access."
line
cat > "$TOKENS_FILE" <<JSON
{ "$TOKEN_V2": { "scope": "embeddings:only", "active": true } }
JSON
echo "        token store updated: v2 re-scoped to embeddings:only"
call_with "app (v2, wrong scope)" "$TOKEN_V2"
echo

line
echo "TAKEAWAY"
echo "A leaked gateway token is a bounded, revocable capability: scope it to one"
echo "route, rate-limit it, and rotate it centrally in seconds. A leaked"
echo "in-process provider key is none of those things. That is the blast-radius"
echo "difference, made concrete. The proxy did not make the compromised app"
echo "safe. It made the loss small and recoverable."
line
