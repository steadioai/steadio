# Integration Guide

Point your existing LLM clients at Elevation by changing one or two lines. The proxy is fully OpenAI-compatible.

## How It Works

Elevation acts as a transparent proxy:

1. Your client sends requests to Elevation instead of directly to OpenAI or Anthropic.
2. Elevation attaches Elevation auth headers, records token usage, checks budgets, and checks for runaway patterns.
3. Elevation forwards the request to the upstream provider and streams the response back.
4. Your application receives the exact same response format it would from the provider directly.

Your existing provider API keys stay in your code. Elevation reads `X-Elevation-Key` for attribution; it never stores or proxies your provider credentials.

## Provider Routes

| Provider  | Elevation Route Prefix   | Original Base URL              | Status    |
|-----------|--------------------------|--------------------------------|-----------|
| OpenAI    | `http://localhost:3001/openai` | `https://api.openai.com/v1` | Available |
| Anthropic | `http://localhost:3001/anthropic` | `https://api.anthropic.com` | Available |
| Google    | `http://localhost:3001/google` | `https://generativelanguage.googleapis.com` | Available |

---

## Python

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/openai",
    api_key="your-openai-api-key",  # still your provider key
    default_headers={
        "X-Elevation-Key": "el_mycompany_abc123",
        "X-Agent-Id": "my-agent",
        # Optional: tag a workflow run
        # "X-Workflow-Id": "workflow-run-abc",
    },
)

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "What is 2 + 2?"}],
)
print(response.choices[0].message.content)
```

### Anthropic SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3001/anthropic",
    api_key="your-anthropic-api-key",
    default_headers={
        "X-Elevation-Key": "el_mycompany_abc123",
        "X-Agent-Id": "my-agent",
    },
)

message = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=1024,
    messages=[{"role": "user", "content": "What is 2 + 2?"}],
)
print(message.content[0].text)
```

### Streaming (Python + OpenAI)

Streaming works exactly as with the standard SDK:

```python
with client.chat.completions.stream(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Tell me a story."}],
) as stream:
    for chunk in stream:
        if chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="", flush=True)
```

Elevation automatically injects `stream_options: { include_usage: true }` to capture token counts from streamed responses.

### Environment-variable approach

Keep Elevation configuration out of your code:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("ELEVATION_PROXY_URL", "http://localhost:3001/openai"),
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers={
        "X-Elevation-Key": os.environ["ELEVATION_API_KEY"],
        "X-Agent-Id": os.environ.get("ELEVATION_AGENT_ID", "default-agent"),
    },
)
```

---

## Node.js / TypeScript

### OpenAI SDK (Node.js)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:3001/openai",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "X-Elevation-Key": process.env.ELEVATION_API_KEY,
    "X-Agent-Id": process.env.ELEVATION_AGENT_ID ?? "my-agent",
  },
});

const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2?" }],
});

console.log(response.choices[0].message.content);
```

### Anthropic SDK (Node.js)

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3001/anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "X-Elevation-Key": process.env.ELEVATION_API_KEY,
    "X-Agent-Id": process.env.ELEVATION_AGENT_ID ?? "my-agent",
  },
});

const message = await client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What is 2 + 2?" }],
});

console.log(message.content[0].text);
```

### Streaming (Node.js + OpenAI)

```typescript
const stream = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Tell me a story." }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

---

## curl

### OpenAI (non-streaming)

```bash
curl http://localhost:3001/openai/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Elevation-Key: el_mycompany_abc123" \
  -H "X-Agent-Id: curl-test" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Ping" }]
  }'
```

### OpenAI (streaming)

```bash
curl http://localhost:3001/openai/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Elevation-Key: el_mycompany_abc123" \
  -H "X-Agent-Id: curl-test" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "stream": true,
    "messages": [{ "role": "user", "content": "Tell me a short joke." }]
  }'
```

### Anthropic

```bash
curl http://localhost:3001/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Elevation-Key: el_mycompany_abc123" \
  -H "X-Agent-Id: curl-test" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 256,
    "messages": [{ "role": "user", "content": "Ping" }]
  }'
```

---

## Tagging Multiple Agents

If you run multiple agents (e.g., a planner, an executor, a reviewer), give each a distinct `X-Agent-Id`. This is the primary dimension for cost attribution in the dashboard.

```python
planner_client = OpenAI(
    base_url="http://localhost:3001/openai",
    api_key=OPENAI_KEY,
    default_headers={
        "X-Elevation-Key": ELEVATION_KEY,
        "X-Agent-Id": "planner",
        "X-Workflow-Id": run_id,  # tie all agents in one run together
    },
)

executor_client = OpenAI(
    base_url="http://localhost:3001/openai",
    api_key=OPENAI_KEY,
    default_headers={
        "X-Elevation-Key": ELEVATION_KEY,
        "X-Agent-Id": "executor",
        "X-Workflow-Id": run_id,
    },
)
```

## LangChain / LangGraph

LangChain's OpenAI integration respects the `base_url` parameter:

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o-mini",
    openai_api_base="http://localhost:3001/openai",
    openai_api_key=OPENAI_KEY,
    model_kwargs={
        "extra_headers": {
            "X-Elevation-Key": ELEVATION_KEY,
            "X-Agent-Id": "langchain-agent",
        }
    },
)
```
