# SteadIO: Never get a surprise AI bill again

[![CI](https://github.com/steadioai/steadio/actions/workflows/ci.yml/badge.svg)](https://github.com/steadioai/steadio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/steadioai/steadio)](https://github.com/steadioai/steadio/releases)

**Never get a surprise AI bill again.** Drop-in LLM proxy with per-agent cost attribution and hard budget enforcement.

> "Our costs have more than tripled since November of '25." - Chamath Palihapitiya on his AI startup's spend. Runaway agents can rack up $50,000 overnight. SteadIO stops them at the source.

## What it does

Point your agents at `http://localhost:3001/openai` instead of OpenAI directly. SteadIO:

1. **Tags every request** with agent ID and team ID
2. **Counts tokens and costs** in real time using provider-accurate pricing
3. **Enforces budget caps**: returns HTTP 402 and kills the agent the moment it exceeds its limit
4. **Stores attribution data** in PostgreSQL so you can pinpoint exactly which agent caused a cost spike

Works with OpenAI and Anthropic. Streaming supported. One environment variable to instrument.

## Screenshots

**Live cost overview** - sample workspace with spend trends, model mix, workflow attribution, and agent-level breakdowns:

![SteadIO live cost overview showing spend trends, model mix, workflow attribution, and agent costs](./docs/screenshots/demo-dashboard.png)

**Design partner onboarding** - the quickstart flow for connecting agents to the SteadIO proxy:

![SteadIO onboarding quickstart showing proxy endpoint, API key handling, and SDK configuration](./docs/screenshots/onboarding-quickstart.png)

## Architecture

```
Your Agent ──→ SteadIO Proxy ──→ LLM Provider (OpenAI / Anthropic)
                    │
                    ↓ (async, fire-and-forget)
              Cost Engine (PostgreSQL + Redis)
                    │
                    ↓
              Dashboard (React)
```

The proxy sits on the hot path: auth, tagging, and budget check run synchronously against Redis (<1ms overhead). Cost attribution is fire-and-forget to keep p99 latency clean.

## Quick Start

### Option A: Zero-config demo (no API keys needed)

```bash
git clone https://github.com/steadioai/steadio
cd steadio
make demo
```

Starts all services, seeds historical cost data across 2 teams and 6 agents, and launches a synthetic traffic generator that keeps posting new events every 5 seconds. Open `http://localhost:5173` to see live cost attribution immediately.

When done: `make clean`

---

### Option B: Manual integration (5 steps)

**1. Start the stack**

```bash
git clone https://github.com/steadioai/steadio
cd steadio
docker compose up -d
```

Starts proxy (3001), cost engine (3002), dashboard (5173), PostgreSQL, and Redis.

**2. Create an API key**

```bash
curl -s -X POST http://localhost:3002/api/keys \
  -H "Content-Type: application/json" \
  -d '{"teamId": "myteam", "name": "dev key"}'
```

Save the `key` value — it is only shown once.

**3. Point your agent at the proxy**

Set the base URL to the SteadIO proxy and add two identification headers:

**OpenAI:**
```bash
export OPENAI_BASE_URL=http://localhost:3001/openai
```

**Anthropic:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:3001/anthropic
```

Add these headers to every request (or set them in your SDK client config):

| Header | Value | Purpose |
|---|---|---|
| `X-SteadIO-Key` | `el_myteam_<suffix>` | Authenticates to SteadIO |
| `X-Agent-Id` | `my-agent` | Tags the request for cost attribution |

Your existing provider `Authorization` / `x-api-key` headers pass through to the upstream unchanged. No other code changes.

**4. Set a budget cap**

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

When the agent hits $10, the proxy returns HTTP 402:

```json
{
  "error": "budget_exceeded",
  "agent_id": "my-agent",
  "cap_amount": 10.00,
  "current_spend": 10.05,
  "reset_at": "2026-06-18T00:00:00.000Z"
}
```

The agent stops. You don't get the bill.

**5. Open the dashboard**

`http://localhost:5173` — real-time cost breakdown by agent and team.

![SteadIO dashboard showing spend trends, model mix, workflow attribution, and agent costs](docs/screenshots/demo-dashboard.png)

## Framework Examples

Working integration examples for the most popular AI frameworks are in [`examples/`](./examples/):

| Example | Framework | Setup |
|---|---|---|
| [`examples/openai-python/`](./examples/openai-python/) | OpenAI Python SDK | `base_url` + two headers |
| [`examples/langchain/`](./examples/langchain/) | LangChain | `openai_api_base` + `default_headers` on `ChatOpenAI` |
| [`examples/llamaindex/`](./examples/llamaindex/) | LlamaIndex | Custom `openai.OpenAI` client passed to LlamaIndex |
| [`examples/multi-agent/`](./examples/multi-agent/) | Any framework | Per-agent `X-Agent-Id` for cost attribution by agent |

All examples work against the demo instance (`make demo`) and require a real OpenAI API key for upstream calls.

## Packages

| Package | Port | Purpose |
|---|---|---|
| `@steadio/proxy` | 3001 | Drop-in LLM proxy: tagging, budget check, streaming |
| `@steadio/cost-engine` | 3002 | Cost attribution, budget enforcement, runaway detection |
| `@steadio/dashboard` | 5173 | React dashboard for cost/budget visibility |
| `@steadio/shared` | - | Shared types and pricing tables |

## Supported Providers

| Provider | Models |
|---|---|
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo |
| Anthropic | claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5, claude-3-5-sonnet, claude-3-5-haiku |
| Google (roadmap) | gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash |

Prefix matching handles versioned model names — `claude-3-5-sonnet-20241022` resolves to `claude-3-5-sonnet` pricing automatically. No code changes needed when providers release new versions.

## Budget Enforcement Modes

| Mode | Behavior |
|---|---|
| `kill` | Returns HTTP 402 immediately when cap is hit |
| `warn` | Allows request, fires alert at `warningThresholdPercent` |

Budget scopes: `agent`, `team`. Periods: `daily`, `weekly`, `monthly`.

SteadIO also detects runaway agents (velocity spike or repeated identical prompts) and opens a circuit breaker before a budget cap is set. The response is HTTP 429:

```json
{
  "error": "circuit_open",
  "agent_id": "my-agent",
  "reason": "velocity",
  "retry_after": "2026-06-18T01:00:00.000Z"
}
```

The agent is blocked until the cooldown expires. You can inspect and reset circuit state from the dashboard.

## Why a proxy instead of SDK instrumentation?

**SDK wrappers drift.** Every provider library update can break your cost tracking. A proxy is provider-agnostic and survives model version bumps without code changes.

**The proxy stops requests before they reach the provider.** SDK-level hooks fire after the network call returns, which is too late if an agent is already in a runaway loop burning tokens.

**Language-agnostic.** One environment variable. Works with Python, TypeScript, Go, or anything that makes HTTP calls.

## How SteadIO compares

|  | SteadIO | Langfuse | Native provider billing |
|---|---|---|---|
| Per-agent cost attribution | Yes | Yes (with SDK) | No |
| Hard budget enforcement | Yes (HTTP 402) | No | No |
| Runaway detection + circuit break | Yes | No | No |
| Language-agnostic (env var only) | Yes | No (SDK per language) | N/A |
| Self-hosted | Yes | Yes | No |
| Streaming support | Yes | Yes | N/A |
| Real-time dashboard | Yes | Yes | Limited |
| Setup | `docker compose up` | Deploy + instrument | Sign up |

Langfuse is excellent for tracing and observability. SteadIO is the layer that **stops runaway agents before they generate a surprise bill**.

## Development

```bash
pnpm install
pnpm --filter @steadio/shared build
pnpm --filter @steadio/proxy dev
pnpm --filter @steadio/cost-engine dev
pnpm --filter @steadio/dashboard dev
```

## Testing

```bash
pnpm --filter @steadio/proxy test
pnpm --filter @steadio/cost-engine test
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, architecture walkthrough, and PR guidelines.

## Support

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/steadioai/steadio/issues)

## License

[MIT](./LICENSE)
