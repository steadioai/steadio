# Production Monitoring

## Health endpoints

Both services expose health endpoints that verify live dependencies:

| Service | URL | Checks |
|---------|-----|--------|
| Proxy | `https://<proxy-host>/health` | Redis + cost-engine reachability |
| Cost Engine | `https://<cost-engine-host>/health` | PostgreSQL (SELECT 1) |

A healthy response returns HTTP 200 with `"status": "ok"`. Any dependency failure returns HTTP 207 with `"status": "degraded"` and the failing component named.

## Uptime monitoring (UptimeRobot, free tier)

UptimeRobot's free tier supports 50 monitors with 5-minute intervals.

1. Sign up at https://uptimerobot.com (free, no credit card needed)
2. Click **Add New Monitor**
3. Configure:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: SteadIO Proxy Health
   - **URL**: `https://<proxy-railway-host>/health`
   - **Monitoring Interval**: 5 minutes
4. Under **Alert Contacts**, add your email or a Slack webhook
5. Save. Monitoring starts immediately

Repeat for the cost-engine health endpoint.

### What to alert on
- Any non-2xx response from `/health` (proxy or cost-engine down)
- Response time > 5s (Railway cold-start or DB connection saturation)

## Error alerting

Proxy errors are written to `stderr` via `console.error` and captured by Railway's log aggregator. Look for these log patterns:

```
[openai-proxy] upstream 5xx:        upstream provider returned 5xx
[anthropic-proxy] upstream 5xx:    upstream provider returned 5xx
[openai-proxy] upstream error:     network-level upstream failure
[anthropic-proxy] upstream error:  network-level upstream failure
[emit] failed to send proxy event: cost-engine unreachable
[runaway] detected:                agent runaway circuit break fired
[budget] enforcement error:        budget enforcement failed
```

Each log line includes `requestId`, `keyId`, `agentId`, and `model` for correlation.

### Railway log search

In the Railway dashboard:
1. Open the **proxy** or **cost-engine** service
2. Click **Logs**
3. Filter by `upstream 5xx` or `runaway` to find errors

### Escalating to Sentry (optional)

If Railway log search becomes insufficient, add Sentry:

```bash
pnpm add @sentry/node
```

Initialize in `packages/proxy/src/server.ts` before the app starts:

```ts
import * as Sentry from "@sentry/node";
Sentry.init({ dsn: process.env.SENTRY_DSN });
```

The free tier captures 5,000 errors/month.

## Usage logging

Every proxied LLM request is persisted to `cost_events` with:

| Field | Description |
|-------|-------------|
| `api_key_id` | API key that made the request (not the secret) |
| `agent_id` | Agent tag from `X-Agent-Id` header |
| `team_id` | Team derived from API key |
| `model` | Model name (e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`) |
| `input_tokens` | Prompt tokens |
| `output_tokens` | Completion tokens |
| `latency_ms` | End-to-end request latency |
| `status_code` | Upstream HTTP status |
| `recorded_at` | UTC timestamp |

Query recent activity:

```sql
SELECT api_key_id, model, input_tokens + output_tokens AS tokens, latency_ms, status_code, recorded_at
FROM cost_events
ORDER BY recorded_at DESC
LIMIT 50;
```
