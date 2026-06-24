# SteadIO Integration Examples

These examples show how to route your existing AI stack through SteadIO with minimal code changes.

## Prerequisites

All examples assume SteadIO is running locally:

```bash
# From repo root
make demo
```

This starts all services and prints a demo API key (`el_demo_...`). Keep that key handy — every example needs it.

You also need a real OpenAI API key for actual LLM calls. The proxy forwards requests to OpenAI and attributes costs; it does not mock the upstream.

## Examples

| Directory | Framework | What it shows |
|---|---|---|
| [`openai-python/`](./openai-python/) | OpenAI Python SDK | Minimal change: set `base_url` + two headers |
| [`langchain/`](./langchain/) | LangChain | `ChatOpenAI` with `openai_api_base` and `default_headers` |
| [`llamaindex/`](./llamaindex/) | LlamaIndex | Inject a custom `openai.OpenAI` client into LlamaIndex's LLM |
| [`multi-agent/`](./multi-agent/) | Any framework | Per-agent cost attribution with different `X-Agent-Id` headers |

## The integration pattern

Every example uses the same two-step pattern:

1. **Point at the proxy**: set `base_url` to `http://localhost:3001/openai` (or `/anthropic`)
2. **Tag the request**: add `X-SteadIO-Key` (your SteadIO key) and `X-Agent-Id` (any string) as headers

```python
# OpenAI SDK — two parameters added
client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url="http://localhost:3001/openai",      # route through SteadIO
    default_headers={
        "X-SteadIO-Key": os.environ["STEADIO_KEY"],
        "X-Agent-Id": "my-agent",                 # attribution tag
    },
)
```

Your existing API calls, chains, and queries work without modification.

## Supported providers

| Provider | Base URL |
|---|---|
| OpenAI | `http://localhost:3001/openai` |
| Anthropic | `http://localhost:3001/anthropic` |

For Anthropic, set `base_url="http://localhost:3001/anthropic"` in the Anthropic SDK, or `ANTHROPIC_BASE_URL=http://localhost:3001/anthropic` as an env var.
