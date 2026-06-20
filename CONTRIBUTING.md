# Contributing to SteadIO

## Prerequisites

- Docker + Docker Compose
- Node.js 22+
- pnpm 9+

## Local setup

```bash
git clone https://github.com/steadioai/steadio
cd steadio
pnpm install
pnpm --filter @steadio/shared build
```

Start the full stack:

```bash
docker compose up -d
```

Or run packages individually with hot reload:

```bash
pnpm --filter @steadio/proxy dev        # port 3001
pnpm --filter @steadio/cost-engine dev  # port 3002
pnpm --filter @steadio/dashboard dev    # port 5173
```

## Running tests

```bash
pnpm test                           # all packages
pnpm --filter @steadio/proxy test # single package
```

Integration tests (requires Docker):

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build --abort-on-container-exit
```

## Architecture

```
Your Agent
    │  OPENAI_BASE_URL=http://localhost:3001/openai
    │  X-SteadIO-Key, X-Agent-Id headers
    ▼
packages/proxy  (Hono, port 3001)
    │  1. Validate X-SteadIO-Key against DB (Redis cache, 5 min TTL)
    │  2. Check budget in Redis — return HTTP 402 if exceeded
    │  3. Forward request to upstream provider (streaming passthrough)
    │  4. Fire-and-forget POST /internal/proxy-events to cost-engine
    ▼
packages/cost-engine  (Hono + Drizzle + TimescaleDB, port 3002)
    │  1. Calculate cost using provider pricing tables in @steadio/shared
    │  2. Persist cost_events row to PostgreSQL
    │  3. Budget enforcement: accumulate spend in Redis, enforce caps
    │  4. Runaway detection: velocity (tokens/min) + loop signature
    │  5. Publish SSE event for real-time dashboard
    ▼
packages/dashboard  (React + Vite, port 5173)
    │  Cost breakdown by agent/team, budget status, runaway history
    │  Polls cost-engine REST API + subscribes to SSE stream
```

## Key directories

```
packages/
  proxy/         Hono app — auth, budget gate, provider forwarding
  cost-engine/   Hono app — cost calculation, DB, budget enforcement
    src/
      routes/    One file per API resource (budgets, attribution, ...)
      services/  Business logic (cost-calculator, budget-enforcer, ...)
      db/        Drizzle schema + client
  dashboard/     React + Vite frontend
  shared/        Pricing tables + shared types (no runtime deps)
infra/
  migrations/    SQL migrations applied by TimescaleDB on first start
```

## Environment variables

| Variable | Service | Default | Description |
|---|---|---|---|
| `PORT` | proxy, cost-engine | 3001 / 3002 | HTTP port |
| `REDIS_URL` | proxy, cost-engine | `redis://localhost:6379` | Redis connection |
| `COST_ENGINE_URL` | proxy | `http://localhost:3002` | Internal cost-engine URL |
| `JWT_SECRET` | proxy | `change-in-production` | Signing secret (unused in MVP) |
| `DATABASE_URL` | cost-engine | see .env.example | PostgreSQL connection string |

Copy `.env.example` to `.env` to run locally outside Docker.

## Pull request checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] New endpoints have a route file under `packages/cost-engine/src/routes/`
- [ ] Pricing changes go in `packages/shared/src/pricing.ts`
- [ ] No secrets or credentials in commits

## Commit style

Conventional Commits: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.

```
feat(proxy): add Google Gemini streaming support
fix(budget): reset daily spend at UTC midnight, not local time
```
