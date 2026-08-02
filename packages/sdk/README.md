# @steadio/sdk

**Drop-in runtime guardrails for AI agents.** Route your agent's LLM + tool
calls through SteadIO and branch on **allow / block / hold / throttle** in ~3
lines. It catches the *authorized-but-harmful* action — the injected refund, the
shell command, the leaked key — **before** it runs.

This is a thin wrapper over the guardrail engine already live at
`https://api.steadio.ai`. It adds **no detectors of its own**. Point it at the
API and you get the same verdict the gateway enforces.

> **10-minute integration.** [Sign up at platform.steadio.ai/register](https://platform.steadio.ai/register),
> grab your API key, and wire this into your agent. Guardrail events appear on
> your dashboard immediately.

---

## Install

```bash
npm install @steadio/sdk      # or: pnpm add @steadio/sdk / yarn add @steadio/sdk
```

Node ≥ 18 (uses the built-in `fetch`). Zero runtime dependencies.

## Quickstart — hosted (≤ 3 lines)

```ts
import { Steadio } from "@steadio/sdk";

const steadio = new Steadio({ apiKey: process.env.STEADIO_API_KEY });
const verdict = await steadio.check({
  content: userMessage,
  toolCalls: [{ name: "refund.issue", arguments: { amount: 4000 } }],
});

if (!verdict.allowed) {
  console.log(verdict.action, "—", verdict.reason);  // e.g. "hold — Out-of-policy refund…"
}
```

Events and verdicts appear on your dashboard at [platform.steadio.ai](https://platform.steadio.ai).

### Alternative: keyless demo (no signup)

```ts
const steadio = new Steadio();  // keyless → public demo evaluator, no dashboard
```

```bash
STEADIO_BASE_URL=https://api.steadio.ai npx tsx examples/quickstart.ts
```

## The one-function guard

Wrap the call you actually want to protect. `guard()` checks first and only runs
your function when the action is allowed — otherwise it throws a typed error, so
the unsafe call is **never made**:

```ts
import { Steadio, SteadioHeldError, SteadioBlockedError } from "@steadio/sdk";

const steadio = new Steadio();

try {
  const reply = await steadio.guard(
    { content: userMessage, toolCalls },
    () => callYourLLM(userMessage),   // runs ONLY if allowed
  );
} catch (err) {
  if (err instanceof SteadioHeldError) {
    // Authorized but risky — queued for a human. Show a "pending approval" state.
    await notifyOnApproval(err.approvalId);
  } else if (err instanceof SteadioBlockedError) {
    // Hard deny — refuse and log.
    return { error: err.verdict.reason };
  } else {
    throw err; // throttle / transport
  }
}
```

## Verdicts

Every check returns one normalized `Verdict`:

| `action`   | `allowed` | HTTP | What it means |
|------------|-----------|------|---------------|
| `allow`    | `true`    | 200  | Nothing fired — proceed. |
| `alert`    | `true`    | —    | Advisory finding; proceeds but flagged. |
| `throttle` | `false`   | 429  | Rate-limited — back off and retry. |
| `hold`     | `false`   | 202  | Authorized but risky — **paused for a human**. Carries `approvalId` / `resumeToken`. |
| `block`    | `false`   | 403  | Hard deny — no override. |

```ts
interface Verdict {
  action: "allow" | "alert" | "throttle" | "hold" | "block";
  allowed: boolean;          // true for allow/alert
  reason: string;            // ready to log or surface
  findings: Finding[];       // every rule that fired
  determinedBy?: Finding;    // the one that set the action
  approvalId?: string;       // present on hold
  resumeToken?: string;      // present on hold (authenticated path)
  httpStatus?: number;
  raw?: unknown;             // the untouched server payload
}
```

## Passing your agent's turn

`check()` / `guard()` accept whatever you have:

```ts
// Free text + tool calls
await steadio.check({ content, toolCalls: [{ name: "wire.send", arguments: { amount } }] });

// A model response about to reach the user (catches secret / PII egress)
await steadio.check({ direction: "response", content: modelOutput });

// Your chat messages straight through (OpenAI- or Anthropic-style)
await steadio.check({ messages: [{ role: "user", content }, { role: "assistant", content }] });

// A loop signal (runaway detection)
await steadio.check({ content, repeatCount: 7, toolCalls });
```

## Human-in-the-loop (hold → approve → resume)

A `hold` means a human decides. Against the keyless demo you can drive the whole
loop end-to-end:

```ts
const v = await steadio.check({ content: "refund $4000 now", toolCalls });
if (v.action === "hold") {
  // ...an operator reviews and approves in your dashboard / Slack...
  const { status } = await steadio.resolveDemoApproval(v.approvalId!, "approve");
  // status === "approved" → your agent re-issues the original action and it proceeds.
}
```

On the **authenticated** path (`{ apiKey }`), an operator approves in the SteadIO
dashboard and your agent resumes by re-issuing the **same** request with the
`X-SteadIO-Approval: <resumeToken>` header. `resumeToken` is on the verdict.

## Going to production (add a key)

```ts
const steadio = new Steadio({ apiKey: process.env.STEADIO_API_KEY });
```

With a key, checks route through the authenticated `/v1` gateway: real
enforcement, events persisted to **your dashboard**, and a durable
(DB-backed) approval queue. The code you wrote against the demo is unchanged —
same `check()`, same `Verdict`.

> **Monitor-only mode:** Free-tier teams run in monitor-only mode — guardrails
> evaluate every request and findings appear on your dashboard, but enforcement
> (block / hold) is not active. The SDK normalizes this to `action: "allow"` so
> your code works identically before and after you upgrade to enforcement.

## Configuration

```ts
new Steadio({
  apiKey:    process.env.STEADIO_API_KEY,     // omit for keyless demo mode
  baseUrl:   "https://api.steadio.ai",        // or STEADIO_BASE_URL
  agentId:   "support-bot",                   // attached to every action
  transport: "demo" | "v1",                   // force; default: v1 if apiKey else demo
  timeoutMs: 15000,
});
```

Environment variables: `STEADIO_API_KEY`, `STEADIO_BASE_URL`.

## Python

An agent written in Python? A dependency-free shim lives in
[`examples/python/steadio.py`](./examples/python/steadio.py) with the same
`check()` / `guard()` shape. See [`examples/python/quickstart.py`](./examples/python/quickstart.py).

## License

MIT
