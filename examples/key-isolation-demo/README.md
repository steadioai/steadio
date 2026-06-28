# Where do your LLM API keys actually live? A blast-radius demo

A small, dependency-free, runnable demonstration of the one architectural
difference that decides how bad a supply-chain compromise gets: whether your
LLM provider key sits in the same process as your application code, or in a
separate proxy process.

It reproduces the core thesis end to end:

- **Architecture A, in-process library**: the app holds the provider key in its
  own environment. A compromised dependency that runs at import reads it.
- **Architecture B, network-proxy**: the same app holds only a scoped gateway
  token. The provider key lives in a separate proxy process, so the same
  compromised dependency cannot reach it.
- **The honest part**: Architecture B still leaks the gateway token. A proxy
  does not make a compromised app safe. It narrows the blast radius. The second
  script shows why that narrower loss is recoverable: the token is scoped and
  can be rotated centrally in seconds, which a leaked provider key never can.

This is **educational demo code only**. The "malicious" dependency is clearly
labeled, self-contained, reads only its own demo environment, prints to stderr,
and exfiltrates nothing. There are no real provider keys, no network egress to
anything external, and no targeting of anything. See
[`malicious_dep.py`](malicious_dep.py) for the full, deliberately boring source.

## Requirements

Python 3.8+ and bash. No `pip install`, no provider account, no external
services. Everything is Python standard library.

## Run it

```bash
./run_demo.sh      # the two architectures, side by side
./rotate_demo.sh   # token scoping + rotation closing the blast radius
```

Each Python process is launched under `env -i`, so the demo only ever sees the
fake credentials it injects, never the real secrets in your shell. The proxy
binds an OS-assigned free port, so it will not collide with anything you have
running.

## What `run_demo.sh` shows

**Architecture A** ([`app_inprocess.py`](app_inprocess.py)): the app reads
`PROVIDER_API_KEY` from its own environment. The compromised dependency runs at
import, in that same environment, and reads the real provider key:

```
[malicious_dep@import] EXFILTRATED PROVIDER_API_KEY = sk-provi...3xyz
```

**Architecture B** ([`app_proxy.py`](app_proxy.py) plus
[`proxy_server.py`](proxy_server.py)): the provider key lives only in the proxy
process. The app holds a `GATEWAY_TOKEN` scoped to one route. The same
dependency runs, but the provider key is not in the app process, so it cannot be
stolen:

```
[malicious_dep@import] EXFILTRATED GATEWAY_TOKEN = gw-scope...-789
```

The app still gets its completion. The proxy used the provider key on the app's
behalf; the app never held it.

## What `rotate_demo.sh` shows

The token from Architecture B was leaked, so this script makes the recovery
concrete:

1. The app calls through the proxy with token v1. Accepted.
2. The attacker replays the stolen token v1 from elsewhere. Also accepted: this
   is the leaked-token window, shown honestly.
3. The operator revokes v1 and issues v2 by editing the proxy's token store. No
   app restart, no redeploy. The proxy re-reads the store live.
4. The attacker's stolen v1 is now rejected (`401`). The app, given v2, keeps
   working.
5. Scoping: even a live token only opens the route it is scoped to. A token
   presented to the wrong route is rejected (`403`), so a leaked token cannot be
   widened into general provider access.

The point is not that the proxy prevented the leak. It is that the leaked thing
was a bounded, revocable capability. A leaked in-process provider key is none of
those things.

## Files

| File | Role |
| --- | --- |
| [`malicious_dep.py`](malicious_dep.py) | the compromised dependency; reads env at import, prints to stderr, exfiltrates nothing |
| [`app_inprocess.py`](app_inprocess.py) | Architecture A app; holds the provider key |
| [`app_proxy.py`](app_proxy.py) | Architecture B app; holds only a scoped gateway token |
| [`proxy_server.py`](proxy_server.py) | Architecture B proxy; holds the provider key, validates and scopes tokens from a live-reloaded store |
| [`run_demo.sh`](run_demo.sh) | runs both architectures side by side |
| [`rotate_demo.sh`](rotate_demo.sh) | demonstrates token scoping and rotation |

## How this maps to real gateways

The demo is provider-agnostic and framework-light on purpose. Swap the stubbed
upstream call in `proxy_server.py` for a real provider call and the result is
identical: in Architecture A the key is in the app process, in Architecture B it
is not. Real-world instances of the proxy pattern include the official LiteLLM
Proxy deployment, cloud API gateways placed in front of model calls, and
proxy-native services. SteadIO is one example of the pattern; it is not the
point of the demo.

License: [MIT](LICENSE).
