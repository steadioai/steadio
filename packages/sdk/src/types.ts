// @steadio/sdk — public types (ELEAA-679, Hackathon Track G).
//
// These mirror the wire contract of the guardrails engine (the same evaluate()
// that runs inline on the /v1 gateway and on the public demo route) but are
// re-declared here so the SDK has ZERO dependency on the server packages — a
// prospect installs one small package, not the monorepo.

/** The five things a guardrail can decide about an agent action. */
export type GuardrailAction = "allow" | "alert" | "throttle" | "hold" | "block";

export type GuardrailRuleType =
  | "privileged_tool_call"
  | "secret_egress"
  | "pii_egress"
  | "prompt_injection"
  | "runaway_loop";

/** A tool / function call the agent wants to execute. */
export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown> | string;
}

/**
 * One agent action to evaluate — either a request about to hit the model or a
 * model response about to reach the user. Everything is optional; pass whatever
 * you have (free text, tool calls, or both).
 */
export interface AgentAction {
  /** Free text sent to / returned from the model. */
  content?: string;
  /** Tool / function calls the agent wants to run. */
  toolCalls?: ToolCall[];
  /** Which side of the boundary this is. Defaults to "request". */
  direction?: "request" | "response";
  /** Loop-detection signal: how many times this action has repeated. */
  repeatCount?: number;
  /** Overrides the client-level agentId for this single action. */
  agentId?: string;
}

/**
 * Convenience shape for the common case: pass your chat messages straight
 * through (OpenAI- or Anthropic-style) and the SDK flattens them into content.
 */
export interface ChatLike {
  messages?: Array<{ role?: string; content?: unknown }>;
  /** OpenAI tool_calls / Anthropic tool_use blocks, or plain {name, arguments}. */
  toolCalls?: ToolCall[];
  direction?: "request" | "response";
  agentId?: string;
}

/** A single rule that matched, with redacted evidence. */
export interface Finding {
  ruleId: string;
  ruleType: GuardrailRuleType;
  mode: Exclude<GuardrailAction, "allow">;
  reason: string;
  evidence?: Record<string, unknown>;
}

/**
 * The normalized verdict the SDK hands back. `allowed` is the one boolean most
 * callers branch on; the richer fields let you build an approval UX or logs.
 */
export interface Verdict {
  /** allow / alert / throttle / hold / block. */
  action: GuardrailAction;
  /** true for "allow" and "alert" (advisory) — the action may proceed. */
  allowed: boolean;
  /** Every rule that fired, highest-severity first. */
  findings: Finding[];
  /** The finding that set the action (highest severity). */
  determinedBy?: Finding;
  /** Human-readable reason for the action, ready to log or surface. */
  reason: string;
  /**
   * Present when action === "hold". Re-issue the same action with this id (or
   * resumeToken) once an operator approves. See Steadio#resume.
   */
  approvalId?: string;
  resumeToken?: string;
  /** Raw transport status (202/403/429/503/200) for debugging. */
  httpStatus?: number;
  /** The raw decision payload from the server, untouched. */
  raw?: unknown;
}
