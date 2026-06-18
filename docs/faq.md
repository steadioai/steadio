# FAQ and Troubleshooting

## Authentication

### What does `401 missing_api_key` mean?

Your request is missing the `X-Elevation-Key` header. Add it:

```bash
-H "X-Elevation-Key: el_mycompany_abc123"
```

Alternatively you can use a `Bearer` token:

```bash
-H "Authorization: Bearer el_mycompany_abc123"
```

If you are also passing a provider `Authorization: Bearer` key, prefer `X-Elevation-Key` for the Elevation key to avoid ambiguity.

### Do I need a separate authorization header for the upstream provider?

Yes. Elevation reads `X-Elevation-Key` for its own authentication. Your upstream provider API key goes in its own header, unchanged:

- **OpenAI**: `Authorization: Bearer $OPENAI_API_KEY`
- **Anthropic**: `x-api-key: $ANTHROPIC_API_KEY` + `anthropic-version: 2023-06-01`

Elevation forwards those headers to the provider. It does not store or inspect your provider credentials.

### How does key validation work?

API keys are validated against the database on every request. Keys must be registered and active — revoked or unknown keys are rejected with `401 invalid_api_key`. Use the `el_<teamId>_<suffix>` format; the `teamId` segment determines team attribution.

---

## Proxy and Routing

### Which URL do I point at for OpenAI vs Anthropic?

| Provider  | Route prefix                         |
|-----------|--------------------------------------|
| OpenAI    | `http://localhost:3001/openai`       |
| Anthropic | `http://localhost:3001/anthropic`    |
| Google    | `http://localhost:3001/google`       |

For OpenAI-compatible SDKs, set `base_url` to `http://localhost:3001/openai`. For Anthropic SDK, set `base_url` to `http://localhost:3001/anthropic`.

### Is Gemini / Google supported?

Yes. Google Gemini models (gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash) are supported. Route requests to `http://localhost:3001/google`.

### I get a 404 calling the proxy — what's wrong?

Check the route prefix. OpenAI chat completions is:

```
POST http://localhost:3001/openai/chat/completions
```

Not:

```
POST http://localhost:3001/v1/chat/completions   # wrong
POST http://localhost:3001/chat/completions       # wrong
```

Anthropic messages is:

```
POST http://localhost:3001/anthropic/v1/messages
```

### Can I change the proxy or cost-engine port?

Yes. Set the `PORT` environment variable in `docker-compose.yml` or your `.env` file before starting the stack. Update any `ELEVATION_PROXY_URL` references in your application accordingly.

---

## Streaming

### Is streaming supported?

Yes, for both OpenAI and Anthropic. Set `"stream": true` in your request body — the proxy pipes the SSE stream directly back to your client.

**OpenAI:** Elevation automatically injects `stream_options: { include_usage: true }` if you do not include it, so token counts are captured correctly from streamed responses.

**Anthropic:** Token counts are extracted from the `message_start` event (input tokens, cache tokens) and the `message_delta` event (output tokens).

### Cost is not appearing for my streamed request

This is usually a timing issue. Elevation processes cost attribution asynchronously after the stream completes. Wait a few seconds and refresh the dashboard.

If cost still does not appear, check that `X-Agent-Id` is set — untagged requests still get stored but may not appear in agent-level views.

---

## Supported Models

### OpenAI

`gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo` — plus version-dated variants like `gpt-4o-2024-08-06`. Version suffixes automatically match the base model for pricing purposes.

### Anthropic

`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022` — plus versioned variants.

### What happens if I use a model not in the pricing table?

The request is proxied normally. Cost attribution falls back to zero for unknown models and a warning is logged. Please report unknown models to your Elevation contact so they can be added to the pricing table.

---

## Budgets and Rate Limiting

### I got a `402 budget_exceeded` response

Your agent or team has hit its configured spending cap for the current period. The response body includes `reset_at` — the UTC time when the budget window resets and requests will be allowed again.

```json
{
  "error": "budget_exceeded",
  "agent_id": "my-agent",
  "cap_amount": 5.00,
  "current_spend": 5.12,
  "reset_at": "2026-06-18T00:00:00.000Z"
}
```

To resume immediately, either:
- Delete the budget via `DELETE http://localhost:3002/api/budgets/<id>`, or
- Increase the cap via the Budgets page in the dashboard.

### I got a `429 circuit_open` response

The runaway detector triggered for your agent. Check the `retry_after` field — the circuit resets automatically after 5 minutes. Review your agent for an infinite loop or unbounded context growth. See [Feature Walkthrough — Runaway Detection](./feature-walkthrough.md#runaway-detection) for details.

---

## Cost Attribution

### My agent is not appearing in the dashboard

Agents and teams are created automatically on the first request. Make sure:
1. `X-Elevation-Key` is present and formatted as `el_<teamId>_<suffix>`.
2. `X-Agent-Id` is set to a non-empty string.
3. The request returned a 2xx status code from the upstream provider.

Requests that return provider errors (4xx/5xx from OpenAI or Anthropic) are still attributed — check the dashboard for error-status requests.

### How is the team ID determined?

From the `X-Elevation-Key` header. The format is `el_<teamId>_<suffix>` — the string between the first and second underscore is used as the team ID. For example, `el_acme_abc123` → team ID `acme`.

You can override this per-request with the `X-Team-Id` header.

### Does Elevation track tool calls?

Yes. When the provider response includes tool calls, Elevation logs the tool name, parameters, result status, latency, and any error type to the `tool_call_logs` table. These appear in the **Tool Calls** page of the dashboard.

---

## Infrastructure

### docker compose up fails with "port already in use"

One of ports 3001, 3002, 5173, 5432, or 6379 is already in use. Find and stop the conflicting process:

```bash
# Find what's using port 3001
lsof -i :3001
# or
ss -tlnp | grep 3001
```

Alternatively, change the host port in `docker-compose.yml`:

```yaml
ports:
  - "3011:3001"   # change the left (host) port
```

### The database is not initializing

The init scripts in `infra/migrations/` run only on a **new** volume. If you are restarting an existing stack, the migration scripts do not re-run. To reset:

```bash
docker compose down -v   # removes the postgres_data volume
docker compose up -d
```

### How do I reset all data for a clean trial start?

```bash
docker compose down -v
docker compose up -d
```

This drops the PostgreSQL and Redis volumes, clearing all cost events, budgets, runaway history, and agent records.

---

## Getting Help

Report issues and share feedback at [jon@elevationnetworks.net](mailto:jon@elevationnetworks.net). Include:
- The request you made (sanitize provider API keys)
- The response you received (status code + body)
- The service logs: `docker compose logs proxy cost-engine`
