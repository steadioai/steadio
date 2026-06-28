# proxy_server.py
#
# A minimal network-proxy gateway. The only thing that matters for the demo:
# the PROVIDER_API_KEY lives in THIS process, not in the application process.
# The app authenticates with a separate gateway token that is scoped to a
# single route and can be revoked centrally.
#
# Stdlib only, no framework, so it is obviously reproducible.
#
# Token store
# -----------
# Valid gateway tokens are read from a JSON file (TOKENS_FILE) on EVERY request,
# so an operator can scope, revoke, and rotate tokens by editing that file with
# no restart and no redeploy of the apps. That is the property the rotation
# demo (rotate_demo.sh) exercises. Shape:
#
#   {
#     "gw-...-789": {"scope": "chat:completions", "active": true},
#     "gw-...-abc": {"scope": "chat:completions", "active": true}
#   }
#
# A token is accepted only if it is present AND active AND its scope permits the
# requested route. Everything else is a 401/403. No provider key ever leaves
# this process.

import os
import sys
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PROVIDER_API_KEY = os.environ.get("PROVIDER_API_KEY", "")
TOKENS_FILE = os.environ.get("TOKENS_FILE", "")
# Route this demo proxy serves. A real gateway would route by path/method.
ROUTE_SCOPE = "chat:completions"


def _load_tokens() -> dict:
    """Re-read the token store on each request so rotation takes effect live."""
    if not TOKENS_FILE or not os.path.exists(TOKENS_FILE):
        return {}
    try:
        with open(TOKENS_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}


class Handler(BaseHTTPRequestHandler):
    def _reject(self, code: int, message: str):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode())

    def do_POST(self):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        tokens = _load_tokens()
        record = tokens.get(token)

        if not token or record is None:
            return self._reject(401, "unknown gateway token")
        if not record.get("active", False):
            return self._reject(401, "gateway token revoked")
        if record.get("scope") != ROUTE_SCOPE:
            return self._reject(403, "gateway token not scoped for this route")

        # Authorized. The proxy holds the provider key and makes the upstream
        # call. The app never sees PROVIDER_API_KEY. We stub the upstream call
        # so the demo has no external dependency.
        using = PROVIDER_API_KEY[:8] + "..." if PROVIDER_API_KEY else "(none)"
        body = {
            "ok": True,
            "upstream_key_used": using,
            "scope": record["scope"],
            "completion": "hello from the model",
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, *args):
        pass  # keep demo output clean


def main():
    port = int(os.environ.get("PROXY_PORT", "8717"))
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(
        f"[proxy] listening on 127.0.0.1:{port}; provider key held in proxy "
        f"process only; tokens from {TOKENS_FILE or '(none)'}",
        file=sys.stderr,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
