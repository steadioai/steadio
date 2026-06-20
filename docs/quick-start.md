# Quick Start Guide

Get SteadIO running locally in under 10 minutes.

## Prerequisites

- Docker and Docker Compose
- Git
- API keys for at least one LLM provider (OpenAI or Anthropic)

## 1. Clone and Start

```bash
git clone https://github.com/steadioai/steadio
cd steadio
docker compose up -d
```

Docker Compose starts four services:

| Service      | Port | Purpose                              |
|--------------|------|--------------------------------------|
| proxy        | 3001 | LLM proxy (OpenAI-compatible)        |
| cost-engine  | 3002 | Cost attribution and budget engine   |
| dashboard    | 5173 | Web dashboard                        |
| db           | 5432 | PostgreSQL (TimescaleDB)             |
| redis        | 6379 | Budget state and circuit breaker     |

Wait for all services to be healthy:

```bash
docker compose ps
```

You should see all services as `healthy` within about 30 seconds.

## 2. Verify Services Are Up

```bash
# Proxy health
curl http://localhost:3001/health

# Cost engine health
curl http://localhost:3002/health

# Dashboard - open in browser
open http://localhost:5173
```

## 3. Create Your API Key

Create a key via the cost-engine API. Supply your team ID (any short identifier) and an optional name:

```bash
curl -s -X POST http://localhost:3002/api/keys \
  -H "Content-Type: application/json" \
  -d '{"teamId": "mycompany", "name": "My first key"}'
```

Response:

```json
{
  "key": "el_mycompany_<random>",
  "id": "...",
  "teamId": "mycompany",
  "name": "My first key",
  "createdAt": "..."
}
```

The `key` field is only returned once — save it. Your team is created automatically if it doesn't exist.

To list existing keys:

```bash
curl http://localhost:3002/api/keys?teamId=mycompany
```

To revoke a key:

```bash
curl -X DELETE http://localhost:3002/api/keys/<id>
```

## 4. Make Your First Request

Test the proxy with a direct curl call. You will need your own provider API key (e.g., your OpenAI key).

```bash
curl http://localhost:3001/openai/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-SteadIO-Key: el_mycompany_abc123" \
  -H "X-Agent-Id: my-first-agent" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{ "role": "user", "content": "Hello, world!" }]
  }'
```

### What these headers do

| Header              | Required | Description                                        |
|---------------------|----------|----------------------------------------------------|
| `X-SteadIO-Key`   | Yes      | Your SteadIO API key (`el_<teamId>_<suffix>`)    |
| `X-Agent-Id`        | Yes      | Identifies which agent made the request            |
| `Authorization`     | Yes      | Your upstream provider API key (unchanged)         |
| `X-Team-Id`         | No       | Override the team extracted from the key           |
| `X-Workflow-Id`     | No       | Tag requests to a specific workflow run            |

## 5. View Your Data in the Dashboard

Open [http://localhost:5173](http://localhost:5173) and navigate to the **Agents** page. After your first request, your agent and team will appear automatically, no manual registration required.

## 6. Configure a Second Provider (Anthropic)

Anthropic requests use a different route prefix:

```bash
curl http://localhost:3001/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-SteadIO-Key: el_mycompany_abc123" \
  -H "X-Agent-Id: my-first-agent" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 256,
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

The provider-specific auth headers (`Authorization: Bearer` for OpenAI, `x-api-key` for Anthropic) are passed through to the upstream provider unchanged. SteadIO only reads `X-SteadIO-Key`.

## Next Steps

- **[Integration Guide](./integration-guide.md)**: Point your existing Python or Node.js LLM clients at SteadIO in minutes.
- **[Feature Walkthrough](./feature-walkthrough.md)**: Cost attribution, budgets, alerts, and runaway detection.
- **[FAQ](./faq.md)**: Troubleshooting, streaming support, supported models.
