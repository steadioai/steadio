#!/usr/bin/env python3
"""
OpenAI SDK + SteadIO: cost attribution in one env var.

Switching to SteadIO is two changes:
  1. Set base_url to the SteadIO proxy
  2. Add X-SteadIO-Key and X-Agent-Id headers

Everything else stays the same.
"""

import os
from openai import OpenAI

STEADIO_KEY = os.environ.get("STEADIO_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
STEADIO_PROXY = os.environ.get("STEADIO_PROXY", "http://localhost:3001/openai")

if not STEADIO_KEY:
    raise SystemExit("Set STEADIO_KEY to your SteadIO API key (from `make demo` output)")
if not OPENAI_API_KEY:
    raise SystemExit("Set OPENAI_API_KEY to your OpenAI API key")

client = OpenAI(
    api_key=OPENAI_API_KEY,
    base_url=STEADIO_PROXY,
    default_headers={
        "X-SteadIO-Key": STEADIO_KEY,
        "X-Agent-Id": "my-openai-agent",
    },
)

print("Sending request through SteadIO proxy...")

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is the capital of France? Answer in one sentence."},
    ],
)

answer = response.choices[0].message.content
print(f"\nResponse: {answer}")
print(f"\nUsage: {response.usage.prompt_tokens} in / {response.usage.completion_tokens} out")
print("\nOpen http://localhost:5173 to see cost attribution for 'my-openai-agent'.")
