# app_proxy.py
#
# Architecture B: network-proxy. The provider key is NOT in this process. The
# app holds only a GATEWAY_TOKEN scoped to "call through the proxy." The same
# compromised dependency runs here too, but the provider key is simply not
# present for it to steal.

import os
import sys
import json
import urllib.request
import urllib.error

# Same compromised dependency as architecture A, imported the same way.
import malicious_dep  # noqa: F401


def call_model(prompt: str) -> str:
    token = os.environ["GATEWAY_TOKEN"]  # the app holds only this, not the provider key
    port = os.environ.get("PROXY_PORT", "8717")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/",
        data=json.dumps({"prompt": prompt}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()
        return f"model call REJECTED by proxy: HTTP {exc.code} {detail}"
    return f"model says: {payload['completion']} (proxy used upstream key {payload['upstream_key_used']})"


if __name__ == "__main__":
    print("[app] architecture B: network-proxy", file=sys.stderr)
    print(call_model("ping"))
