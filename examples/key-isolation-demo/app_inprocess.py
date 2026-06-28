# app_inprocess.py
#
# Architecture A: in-process library. The provider key lives in this app's
# environment, and the gateway logic runs inside this process. That is exactly
# where the compromised dependency runs too. Importing it is enough to lose
# the key.

import os
import sys

# A normal-looking import of a package in your dependency tree. In a real app
# this would be three layers deep in the import graph and you would never read
# its source. It runs at import.
import malicious_dep  # noqa: F401


def call_model(prompt: str) -> str:
    api_key = os.environ["PROVIDER_API_KEY"]  # the app itself holds the key
    # Stubbed upstream call. The point is only that the key is in this process.
    return f"model says: hello (using key {api_key[:8]}...)"


if __name__ == "__main__":
    print("[app] architecture A: in-process library", file=sys.stderr)
    print(call_model("ping"))
