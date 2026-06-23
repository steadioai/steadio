# Quick Start: From Zero to Cost Attribution in 5 Minutes

No API keys required for the demo path. You can see real cost attribution with `make demo` and seeded data before connecting a live agent.

## Prerequisites

- Docker and Docker Compose
- Git

---

## Step 1: Clone and launch

```bash
git clone https://github.com/steadioai/steadio
cd steadio
make demo
```

`make demo` starts all services, waits for them to be healthy, seeds 12 sample cost events across 2 teams and 6 agents, and prints a demo API key.

Expected output:

```
SteadIO - Demo

Starting services...
  + Docker Compose started

Waiting for services to be healthy...
  + Proxy is healthy
  + Cost Engine is healthy

Seeding demo data...
  + Seeded 12 sample cost events across 2 teams and 6 agents
  + Created daily budget: code-agent capped at $5.00/day

Demo ready!

  Dashboard:    http://localhost:5173
  Proxy:        http://localhost:3001
  Cost Engine:  http://localhost:3002
```

---

## Step 2: Verify services are healthy

```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
```

Both should return `{"status":"ok"}`. If either fails, check `docker compose ps` and look for unhealthy services, then run `docker compose logs <service-name>` for details.

---

## Step 3: Open the dashboard

Open [http://localhost:5173](http://localhost:5173) in your browser.

You should see:
- 2 teams (`acme` and `startup`) with cost breakdown
- 6 agents with per-model spend
- A daily budget cap on `code-agent` showing utilization

This is all seeded data — no real API calls were made.

---

## Step 4: Point your agent at the proxy

When you're ready to route live traffic, change your agent's base URL and add two identification headers.

**Create your API key first:**

```bash
curl -s -X POST http://localhost:3002/api/keys \
  -H "Content-Type: application/json" \
  -d '{"teamId": "myteam", "name": "my key"}'
```

Save the `key` value — it is only shown once.

**OpenAI agents:**

```bash
export OPENAI_BASE_URL=http://localhost:3001/openai
```

Python:

```python
import openai
client = openai.OpenAI(
    base_url="http://localhost:3001/openai",
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers={
        "X-SteadIO-Key": "el_myteam_<suffix>",
        "X-Agent-Id": "my-agent",
    },
)
```

TypeScript/Node.js:

```typescript
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://localhost:3001/openai",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "X-SteadIO-Key": "el_myteam_<suffix>",
    "X-Agent-Id": "my-agent",
  },
});
```

**Anthropic agents:**

```bash
export ANTHROPIC_BASE_URL=http://localhost:3001/anthropic
```

Python:

```python
import anthropic
client = anthropic.Anthropic(
    base_url="http://localhost:3001/anthropic",
    api_key=os.environ["ANTHROPIC_API_KEY"],
    default_headers={
        "X-SteadIO-Key": "el_myteam_<suffix>",
        "X-Agent-Id": "my-agent",
    },
)
```

TypeScript/Node.js:

```typescript
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({
  baseURL: "http://localhost:3001/anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "X-SteadIO-Key": "el_myteam_<suffix>",
    "X-Agent-Id": "my-agent",
  },
});
```

**Header reference:**

| Header | Required | Description |
|---|---|---|
| `X-SteadIO-Key` | Yes | Your SteadIO API key (`el_<teamId>_<suffix>`) |
| `X-Agent-Id` | Yes | Identifies which agent made the request |
| `X-Team-Id` | No | Override team derived from the key |
| `X-Workflow-Id` | No | Tag requests to a specific workflow run |

Your existing provider `Authorization: Bearer` (OpenAI) or `x-api-key` (Anthropic) headers pass through to the upstream unchanged.

---

## Step 5: Set a budget cap

Stop runaway agents before they generate a surprise bill:

```bash
curl -X POST http://localhost:3002/api/budgets \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "agent",
    "scopeId": "my-agent",
    "period": "daily",
    "capUsd": 10.00,
    "enforcementMode": "kill"
  }'
```

When `my-agent` hits $10 in a day, the proxy returns HTTP 402:

```json
{
  "error": "budget_exceeded",
  "agent_id": "my-agent",
  "cap_amount": 10.00,
  "current_spend": 10.05,
  "reset_at": "2026-06-19T00:00:00.000Z"
}
```

The agent stops immediately. The error is returned before the upstream provider is called, so you are not charged for the blocked request.

---

## Troubleshooting

**`401 missing_api_key`** — Add the `X-SteadIO-Key` header. Create a key with `POST http://localhost:3002/api/keys`.

**`401 invalid_or_revoked_key`** — The key was not recognized. Double-check the value or create a new one.

**`502 upstream_unavailable`** — SteadIO could not reach the provider API. Check that your provider API key is valid and that Docker has outbound internet access.

**`404 not_found`** — Wrong proxy path. Use `/openai/...` for OpenAI requests and `/anthropic/...` for Anthropic requests.

**`402 budget_exceeded`** — The agent or team has exceeded its cap. Check the dashboard for current spend, or wait for the reset period.

**Services not healthy after `docker compose up`** — Run `docker compose logs db` to check if TimescaleDB initialized correctly. The first pull can take 30-60 seconds.

---

## Next Steps

- **[Integration Guide](./integration-guide.md)** — Point existing Python or Node.js LLM clients at SteadIO.
- **[Feature Walkthrough](./feature-walkthrough.md)** — Cost attribution, budgets, alerts, and runaway detection in depth.
- **[FAQ](./faq.md)** — Streaming support, supported models, common questions.
