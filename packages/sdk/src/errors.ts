// @steadio/sdk — typed errors thrown by Steadio#guard so callers can branch with
// try/catch instead of inspecting a verdict object. Each carries the verdict.

import type { Verdict } from "./types.js";

/** Base for every guardrail-triggered stop. Always carries the verdict. */
export class SteadioGuardrailError extends Error {
  readonly verdict: Verdict;
  constructor(message: string, verdict: Verdict) {
    super(message);
    this.name = "SteadioGuardrailError";
    this.verdict = verdict;
  }
}

/** Hard deny — the action must not run and there is no human override. */
export class SteadioBlockedError extends SteadioGuardrailError {
  constructor(verdict: Verdict) {
    super(verdict.reason || "Action blocked by a SteadIO guardrail", verdict);
    this.name = "SteadioBlockedError";
  }
}

/** Rate-limited — back off and retry. */
export class SteadioThrottledError extends SteadioGuardrailError {
  constructor(verdict: Verdict) {
    super(verdict.reason || "Action throttled by a SteadIO guardrail", verdict);
    this.name = "SteadioThrottledError";
  }
}

/**
 * Held for human approval. The action is authorized but risky. `approvalId` /
 * `resumeToken` let you resume once an operator approves (Steadio#resume).
 */
export class SteadioHeldError extends SteadioGuardrailError {
  readonly approvalId: string | undefined;
  readonly resumeToken: string | undefined;
  constructor(verdict: Verdict) {
    super(verdict.reason || "Action held for human approval", verdict);
    this.name = "SteadioHeldError";
    this.approvalId = verdict.approvalId;
    this.resumeToken = verdict.resumeToken;
  }
}

/** Transport / auth failure (bad key, network, 5xx that isn't the allow-503). */
export class SteadioTransportError extends Error {
  readonly status: number | undefined;
  readonly body: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = "SteadioTransportError";
    this.status = status;
    this.body = body;
  }
}
