#!/usr/bin/env python3
"""
LlamaIndex + SteadIO: pass a custom OpenAI client with SteadIO headers.

LlamaIndex's OpenAI LLM accepts a pre-built openai.OpenAI client,
so you can inject SteadIO the same way as the raw SDK example.
"""

import os
import openai
from llama_index.llms.openai import OpenAI as LlamaOpenAI
from llama_index.core.llms import ChatMessage

STEADIO_KEY = os.environ.get("STEADIO_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
STEADIO_PROXY = os.environ.get("STEADIO_PROXY", "http://localhost:3001/openai")

if not STEADIO_KEY:
    raise SystemExit("Set STEADIO_KEY to your SteadIO API key (from `make demo` output)")
if not OPENAI_API_KEY:
    raise SystemExit("Set OPENAI_API_KEY to your OpenAI API key")

# Build a custom OpenAI client that routes through SteadIO
openai_client = openai.OpenAI(
    api_key=OPENAI_API_KEY,
    base_url=STEADIO_PROXY,
    default_headers={
        "X-SteadIO-Key": STEADIO_KEY,
        "X-Agent-Id": "llamaindex-agent",
    },
)

# Pass it to LlamaIndex — all LLM calls go through the proxy
llm = LlamaOpenAI(model="gpt-4o-mini", openai_client=openai_client)

print("Querying through SteadIO proxy via LlamaIndex...")

messages = [
    ChatMessage(role="system", content="You are a concise technical writer."),
    ChatMessage(role="user", content="In two sentences, explain what a vector database is."),
]

response = llm.chat(messages)
print(f"\nResponse: {response.message.content}")

# Show token usage if available
if hasattr(response, "raw") and response.raw:
    usage = response.raw.get("usage", {})
    if usage:
        print(f"\nUsage: {usage.get('prompt_tokens', '?')} in / {usage.get('completion_tokens', '?')} out")

print("\nOpen http://localhost:5173 to see cost attribution for 'llamaindex-agent'.")
