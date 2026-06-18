# Feature Walkthrough

## Cost Attribution Dashboard

Open the dashboard at [http://localhost:5173](http://localhost:5173).

### Overview Page

The overview gives a real-time snapshot of LLM spend across your entire organization:

- **Total spend** for the selected time period (1d, 7d, 30d)
- **Request volume** and average cost per request
- **Top agents** by spend
- **Cost over time** chart bucketed by hour or day

### Teams Page

Breaks down spend by team. Click a team row to drill into its agents. Useful when you have multiple product areas or engineering squads sharing a single deployment.

### Agents Page

The primary attribution view. Each row is one agent ID from your `X-Agent-Id` header:

- Total cost, request count, and average latency
- Model distribution (what percentage of spend goes to each model)
- Trend vs. prior period

Click an agent to open the **Agent Detail** view, which shows per-model cost breakdown and recent request history.

### How Attribution Works

Every request tagged with `X-Agent-Id` is attributed to that agent. The proxy captures token counts from the provider response (or from the streaming event sequence), multiplies by the per-model pricing, and stores the result in the cost database.

**Pricing used for attribution (per 1,000 tokens):**

| Model                   | Input      | Output      | Cache Read | Cache Write |
|-------------------------|------------|-------------|------------|-------------|
| gpt-4o                  | $0.0025    | $0.0100     | —          | —           |
| gpt-4o-mini             | $0.00015   | $0.00060    | —          | —           |
| gpt-4-turbo             | $0.0100    | $0.0300     | —          | —           |
| gpt-3.5-turbo           | $0.00050   | $0.00150    | —          | —           |
| claude-opus-4-8         | $0.0150    | $0.0750     | —          | —           |
| claude-sonnet-4-6       | $0.0030    | $0.0150     | —          | —           |
| claude-haiku-4-5        | $0.00080   | $0.00400    | —          | —           |
| claude-3-5-sonnet       | $0.0030    | $0.0150     | $0.00030   | $0.00375    |
| claude-3-5-haiku        | $0.00080   | $0.00400    | $0.00008   | $0.00100    |
| gemini-1.5-pro          | $0.00125   | $0.00500    | —          | —           |
| gemini-1.5-flash        | $0.000075  | $0.000300   | —          | —           |
| gemini-2.0-flash        | $0.000100  | $0.000400   | —          | —           |

Anthropic prompt cache tokens (read and write) are tracked separately and appear in the agent detail breakdown.

---

## Budget Setup

Budgets cap spending by agent or team over a rolling time window.

### Create a Budget via API

```bash
curl -X POST http://localhost:3002/api/budgets \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "agent",
    "scopeId": "my-agent",
    "period": "daily",
    "capUsd": 5.00,
    "warningThresholdPercent": 80,
    "enforcementMode": "kill"
  }'
```

**Fields:**

| Field                      | Values                     | Description                                              |
|----------------------------|----------------------------|----------------------------------------------------------|
| `scope`                    | `agent` \| `team`          | Whether the cap applies per-agent or per-team            |
| `scopeId`                  | string                     | The agent ID or team ID                                  |
| `period`                   | `daily` \| `weekly` \| `monthly` | Reset cadence                                    |
| `capUsd`                   | number                     | Maximum spend in USD for the period                      |
| `warningThresholdPercent`  | 0–100 (default: 80)        | Triggers an alert at this percentage of cap              |
| `enforcementMode`          | `alert` \| `throttle` \| `kill` | What happens when the cap is reached              |

### Enforcement Modes

**`alert`** — The agent can continue making requests, but a warning event is logged at `warningThresholdPercent` of cap. No requests are blocked.

**`throttle`** — Requests still go through but Elevation logs an alert. (Hard throttling is on the roadmap.)

**`kill`** — Elevation blocks all requests from the agent or team once the cap is hit, returning HTTP 429 with a `budget_exceeded` error until the period resets.

### Budget Reset Windows

- **Daily**: UTC midnight to 23:59
- **Weekly**: Sunday UTC midnight through Saturday 23:59
- **Monthly**: 1st to last day of the calendar month (UTC)

### Budget Response When Exceeded (kill mode)

```json
{
  "error": "budget_exceeded",
  "agent_id": "my-agent",
  "cap_amount": 5.00,
  "current_spend": 5.12,
  "reset_at": "2026-06-18T00:00:00.000Z"
}
```

Status code: `402 Payment Required`

### Viewing Budgets in the Dashboard

The **Budgets** page lists all configured budgets with current utilization. A progress bar shows spend vs. cap; budgets in warning state turn amber, exhausted budgets turn red.

### Manage Budgets

```bash
# List budgets for an agent
curl "http://localhost:3002/api/budgets?scope=agent&scopeId=my-agent"

# Delete a budget
curl -X DELETE http://localhost:3002/api/budgets/<budget-id>
```

---

## Runaway Detection

Runaway detection catches two failure modes common in agentic systems: a sudden token spike (velocity) and an infinite retry loop (loop detection).

### Velocity Detection

**What it detects:** An agent whose current request has 10× or more tokens than its recent baseline.

**How it works:**
- Tracks the last 5 minutes of token counts for each agent in Redis.
- Requires at least 3 prior samples to compute a baseline.
- If the current request exceeds 10× the baseline average, a runaway event is recorded.

**Typical cause:** A prompt that accidentally loops, a context window that grows unbounded, or a tool that returns an unexpectedly large payload.

### Loop Detection

**What it detects:** The same prompt sent 5 or more times within 60 seconds.

**How it works:**
- Computes a SHA-256 hash of the request messages on every call.
- Counts identical hashes within a 60-second window.
- Triggers at 5 identical prompts in 60 seconds.

**Typical cause:** A broken retry loop, an agent stuck in a reasoning cycle, or a workflow that mistakenly re-dispatches the same task.

### Circuit Breaker

When either trigger fires:

1. The current request is completed (the triggering request is not blocked).
2. The circuit breaker opens for that agent ID.
3. All subsequent requests from that agent return HTTP 429:

```json
{
  "error": "circuit_open",
  "agent_id": "my-agent",
  "reason": "velocity",
  "retry_after": "2026-06-17T14:05:00.000Z"
}
```

4. After a **5-minute cooldown**, the circuit moves to half-open — one test request is allowed through.
5. If that request succeeds normally, the circuit closes and the agent resumes.

### Viewing Runaway Events

The **Runaway Events** page in the dashboard shows:
- Trigger type (`velocity` or `loop`)
- Token count at trigger
- Estimated cost of the triggering request
- Cooldown expiry time
- Whether the circuit was manually overridden

### Responding to a Runaway

If you receive a 429 `circuit_open` response in your agent:
1. Check the `retry_after` timestamp — the circuit resets automatically after 5 minutes.
2. Review your agent's logic for the failure mode (runaway loop, huge context, etc.).
3. Fix the issue, then let the cooldown expire and retry.

---

## Alert Configuration

Elevation can send webhook or Slack alerts when budget thresholds are hit or runaways are detected.

```bash
curl -X POST http://localhost:3002/api/alerts \
  -H "Content-Type: application/json" \
  -d '{
    "teamId": "mycompany",
    "alertType": "budget_warning",
    "channel": "slack",
    "destination": "https://hooks.slack.com/services/..."
  }'
```

| Field        | Values                       | Description                  |
|--------------|------------------------------|------------------------------|
| `alertType`  | `budget_warning` \| `runaway` | Event type to subscribe to  |
| `channel`    | `slack` \| `webhook`         | Delivery channel             |
| `destination`| URL string                   | Webhook URL or Slack hook URL|

Alert history is visible on the **Alert History** page in the dashboard.

---

## Real-Time Updates

The cost engine publishes spend updates over Server-Sent Events at:

```
GET http://localhost:3002/sse
```

The dashboard subscribes to this endpoint automatically. External clients can also connect to get a live feed of cost events as they are processed.
