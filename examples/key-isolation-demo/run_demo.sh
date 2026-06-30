#!/usr/bin/env bash
# run_demo.sh
#
# Runs both architectures against the same compromised dependency and shows the
# difference in blast radius. No external services, stdlib only.
set -euo pipefail
cd "$(dirname "$0")"

PROVIDER_API_KEY="sk-provider-REALSECRET-abc123xyz"
GATEWAY_TOKEN="gw-scoped-token-only-calls-proxy-789"
# Ask the OS for a free port so the demo never collides with something already
# listening. Falls back to 8717 if that lookup fails.
PROXY_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 8717)"
TOKENS_FILE="$(mktemp)"
PROXY_LOG="$(mktemp)"
trap 'rm -f "$TOKENS_FILE" "$PROXY_LOG"' EXIT

# The proxy's token store: this one token is active and scoped to the single
# route the proxy serves. Editing this file is how an operator rotates.
cat > "$TOKENS_FILE" <<JSON
{ "$GATEWAY_TOKEN": { "scope": "chat:completions", "active": true } }
JSON

line() { printf '%s\n' "------------------------------------------------------------"; }

# We run every Python process with `env -i` so it starts from a clean
# environment containing ONLY the variables the demo injects. That keeps the
# output deterministic and, importantly, means the demo never reads real
# secrets that happen to be in your shell. PATH is passed through so python3
# resolves; PYTHONPATH points at this directory for the local imports.
DEMO_PATH="$PATH"
HERE="$(pwd)"
run_clean() { env -i PATH="$DEMO_PATH" PYTHONPATH="$HERE" "$@"; }

line
echo "ARCHITECTURE A: in-process library"
echo "The provider key is in the app environment, next to the dependency."
line
# The malicious dependency can see PROVIDER_API_KEY because it is in this env.
run_clean PROVIDER_API_KEY="$PROVIDER_API_KEY" python3 app_inprocess.py
echo

line
echo "ARCHITECTURE B: network-proxy"
echo "The provider key lives only in the proxy process. The app holds a scoped token."
line
# Start the proxy WITH the provider key, in its own isolated process. We send
# its output to a log file rather than letting it inherit this script's stdout/
# stderr. That is the difference between a clean exit and a hang: a backgrounded
# proxy that holds the pipe open keeps a downstream reader (./run_demo.sh | tee
# log) waiting on EOF forever, even after all output is printed.
run_clean PROVIDER_API_KEY="$PROVIDER_API_KEY" TOKENS_FILE="$TOKENS_FILE" PROXY_PORT="$PROXY_PORT" \
  python3 proxy_server.py >/dev/null 2>"$PROXY_LOG" &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true; rm -f "$TOKENS_FILE" "$PROXY_LOG"' EXIT
# Give the proxy a moment to bind, then surface its startup line ourselves.
for _ in 1 2 3 4 5 10 20; do
  if python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',$PROXY_PORT))==0 else 1)" 2>/dev/null; then
    break
  fi
  sleep 0.2
done
cat "$PROXY_LOG" >&2
# The app runs WITHOUT the provider key in its environment. Only the gateway token.
run_clean GATEWAY_TOKEN="$GATEWAY_TOKEN" PROXY_PORT="$PROXY_PORT" python3 app_proxy.py
echo

line
echo "TAKEAWAY"
echo "Architecture A: the dependency exfiltrated the real provider key."
echo "Architecture B: the dependency saw only a scoped gateway token; the"
echo "provider key was never in the app process. Honest caveat: the token IS"
echo "exposed, so scope it narrowly and rotate it. The point is reduced blast"
echo "radius, not magic. Run ./rotate_demo.sh to see the rotation close it."
line
