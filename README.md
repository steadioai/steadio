# Elevation Networks — Agent Reliability Control Plane

[![CI](https://github.com/Elevation-Networks/agent-view/actions/workflows/ci.yml/badge.svg)](https://github.com/Elevation-Networks/agent-view/actions/workflows/ci.yml)

Real-time cost attribution, tool call monitoring, budget enforcement, and runaway prevention for production AI agent fleets.

## Architecture

```
Your Agent ──→ Elevation Proxy ──→ LLM Provider (OpenAI / Anthropic / Google)
                    │
                    ↓ (async, fire-and-forget)
              Cost Engine (PostgreSQL + Redis)
                    │
                    ↓
              Dashboard (React)
```

## Packages

| Package | Port | Purpose |
|---|---|---|
| `@elevation/proxy` | 3001 | Drop-in LLM proxy — tagging, budget check, streaming |
| `@elevation/cost-engine` | 3002 | Cost attribution, budget enforcement, runaway detection |
| `@elevation/dashboard` | 5173 | React dashboard for cost/budget visibility |
| `@elevation/shared` | — | Shared types and pricing tables |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Elevation-Networks/agent-view
cd agent-view
pnpm install

# 2. Start the stack (requires Docker)
docker compose up -d

# 3. Instrument your agent (one-line change)
# OpenAI:
OPENAI_BASE_URL=http://localhost:3001/openai

# Anthropic:
ANTHROPIC_BASE_URL=http://localhost:3001/anthropic

# Add tagging headers:
X-Elevation-Key: el_<teamId>_<apiKey>
X-Agent-Id: my-agent
X-Team-Id: my-team
```

## Development

```bash
pnpm install
pnpm --filter @elevation/shared build
pnpm --filter @elevation/proxy dev
pnpm --filter @elevation/cost-engine dev
pnpm --filter @elevation/dashboard dev
```

## Testing

```bash
pnpm --filter @elevation/proxy test
pnpm --filter @elevation/cost-engine test
```

## Budget Enforcement

Set a budget cap for an agent:

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

When the agent exceeds its budget, the proxy returns HTTP 402:

```json
{
  "error": "budget_exceeded",
  "agent_id": "my-agent",
  "cap_amount": 10.00,
  "current_spend": 10.05,
  "reset_at": "2026-06-18T00:00:00.000Z"
}
```

## License

MIT
