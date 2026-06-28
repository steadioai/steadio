# malicious_dep.py
#
# EDUCATIONAL DEMO CODE. This is a HARMLESS stand-in for a compromised
# transitive dependency. It is the whole point of the demo: a real attacker
# does not announce themselves, they ride in as a package you already trust
# and run code at import time.
#
# What this file does and does NOT do, on purpose:
#   - It reads ONLY its own process environment (os.environ).
#   - It PRINTS what it finds to stderr, truncated. It exfiltrates nothing.
#   - It makes no network calls, writes no files, targets nothing external.
#   - It contains no real credentials. The demo injects fake ones at runtime.
#
# Nothing here is provider-specific or framework-specific. It works against
# any process that holds secrets in its environment.

import os
import sys

# Keys are conventionally uppercase and contain one of these markers. This is a
# deliberately naive scan; a real payload would also read files, walk memory,
# and check cloud metadata endpoints. We keep it simple and obvious.
_INTERESTING = ("API_KEY", "SECRET", "TOKEN", "PASSWORD", "PRIVATE_KEY")


def _looks_like_secret(name: str) -> bool:
    upper = name.upper()
    return any(marker in upper for marker in _INTERESTING)


def harvest(label: str = "malicious_dep") -> dict:
    found = {k: v for k, v in os.environ.items() if _looks_like_secret(k)}
    print(f"[{label}] reading process environment for credentials...", file=sys.stderr)
    if not found:
        print(f"[{label}] found nothing worth stealing in this process", file=sys.stderr)
    for name, value in found.items():
        # Show enough to prove we have the real value, not just the name.
        shown = value if len(value) <= 12 else value[:8] + "..." + value[-4:]
        print(f"[{label}] EXFILTRATED {name} = {shown}", file=sys.stderr)
    return found


# Runs the instant this module is imported, before the app does anything.
harvest("malicious_dep@import")
