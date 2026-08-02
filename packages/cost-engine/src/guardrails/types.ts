// Guardrail rule engine — shared types (ELEAA-640, Hackathon Track A).
//
// The /v1 gateway already enforces *budget* (alert / throttle / kill) before the
// provider call. These types extend that same enforcement path to *reliability
// signals* so "runtime guardrails" is a real, demoable product: an unsafe agent
// action is caught inline, before it reaches the model or the user.
//
// The engine is deliberately pure and I/O-free so it can be unit-tested at its
// boundary and reused unchanged in three places: the /v1 gateway (live
// enforcement), the public demo route, and the in-browser landing narrative.

export type GuardrailRuleType =
  | "privileged_tool_call" // agent tries to invoke a dangerous/privileged tool
  | "secret_egress" // provider key / private key / token leaving in content
  | "pii_egress" // PII (email, SSN, card, phone) leaving in content
  | "prompt_injection" // known injection / instruction-override phrasing
  | "tool_poisoning" // a tool's own name/description carries injected instructions
  | "runaway_loop" // same action repeated past a threshold (regression)
  | "content_moderation" // hate/violence/sexual/self-harm/illicit content (ELEAA-789, G3)
  | "groundedness" // RAG answer drifted from its retrieved context (ELEAA-790/G2)
  | "kill_switch"; // operator freeze (ELEAA-747) — not a matcher; see AgentFreeze

// Enforcement modes, mirrored from the budget path (enforcementModeEnum uses
// alert/throttle/kill; the guardrail domain says "block" where budget says
// "kill" — same terminal action, clearer verb for a caught unsafe action).
//
// "hold" is the reliability wedge's signature verdict (ELEAA-641): the action is
// authorized but harmful, so we don't reject it outright — we pause it for a
// human to approve or deny (human-in-the-loop). The customer never sees the bad
// action, but a legitimate one is one click away. It sits just below "block":
// a hard-deny rule still wins over a hold.
//
// "redact" (ELEAA-788, G4a) is the graceful-degradation verdict competitors call
// "mask and forward": a PII/secret match is masked out and the request PROCEEDS
// with the rest intact. It is the only mode that MUTATES content, so unlike the
// others it needs a caller apply-step (see GuardrailFinding.transform +
// applyRedactions). It sits between throttle and hold: non-terminal (the request
// completes) but stronger than a throttle, and any hold/block still wins over it.
export type GuardrailMode = "alert" | "throttle" | "redact" | "hold" | "block";

// The resulting action for the whole request: "allow" plus the modes,
// ordered by severity below.
export type GuardrailAction = "allow" | GuardrailMode;

export const ACTION_SEVERITY: Record<GuardrailAction, number> = {
  allow: 0,
  alert: 1,
  throttle: 2,
  redact: 3, // non-terminal (request proceeds), above throttle, below hold (ELEAA-788)
  hold: 4,
  block: 5,
};

export interface GuardrailRule {
  id: string;
  type: GuardrailRuleType;
  mode: GuardrailMode;
  enabled: boolean;
  description: string;
  // Type-specific configuration. Each matcher reads only the keys it needs and
  // falls back to a sensible built-in default when a key is absent.
  config?: GuardrailRuleConfig;
}

export interface GuardrailRuleConfig {
  // privileged_tool_call (the high-risk action gate)
  //
  // allowlist (the "firewall" verb — ELEAA-745). When set and non-empty, the
  // gate switches to a positive security model: ONLY tools whose name matches an
  // allowlist entry may be invoked; any other tool call is blocked outright. This
  // is what Lakera/Guardrails-AI/Portkey leave open — per-agent tool authorization
  // — and what June-2026 NSA/DoD MCP guidance expects. Absent/empty = denylist
  // mode (below), so existing teams are unaffected until they opt in.
  allowedTools?: string[]; // positive allowlist; empty/absent = disabled
  guardrailMode?: "monitor" | "block"; // monitor = would_block findings; block = inline deny
  deniedTools?: string[]; // hard-deny: infra-destructive tools, always blocked
  deniedArgPatterns?: string[]; // regex sources matched against stringified args
  actionTools?: string[]; // authorized-but-risky business actions (refund, wire…)
  actionPolicies?: ActionPolicy[]; // per-action parameter policy (amount caps, etc.)
  escalateOnInjection?: GuardrailMode; // verdict when injection co-occurs with an
  // action (default "hold"): injection is a *signal into this rule*, not a
  // standalone classifier (ELEAA-641 — don't compete with Lakera on text).
  // secret_egress / pii_egress / prompt_injection
  patterns?: string[]; // extra regex sources, merged with the built-in set
  // runaway_loop
  repeatThreshold?: number; // fire when repeatCount >= threshold (default 5)
  // content_moderation (ELEAA-789, G3). Per-category score thresholds — a category
  // present here is enabled and fires when its 0..1 moderation score reaches the
  // threshold; a category ABSENT from the map is disabled and never fires (that is
  // acceptance-#3: a disabled category is silent). Absent map => the built-in
  // DEFAULT_MODERATION_CATEGORIES set. The verdict is direction-based per the spec:
  // alert on the request side, block on response egress, each overridable below.
  moderationCategories?: Record<string, number>;
  moderationRequestMode?: GuardrailMode; // default "alert"
  moderationResponseMode?: GuardrailMode; // default "block"
  // groundedness (RAG faithfulness — ELEAA-790/G2). The judge (an NLI/faithfulness
  // model, run in the A0 async signal lane) scores 0..1 how well the response is
  // supported by ctx.sourceContext; a score below `groundednessThreshold` fires at
  // the rule's mode (default alert; regulated buyers can set hold/block).
  groundednessThreshold?: number; // fire when score < threshold (default 0.75)
  // When true, a response with NO source context supplied is itself a finding: a
  // RAG flow that answered without retrieval is ungrounded by construction. Default
  // false — the rule is inert without source context, so non-RAG traffic is
  // unaffected (ELEAA-790 acceptance #2).
  requireSourceContext?: boolean;
  // prompt_injection / privileged_tool_call — optional model-based CLASSIFIER TIER
  // (ELEAA-791 / G1). Regex-only stays the default; when set, the classifier runs
  // AFTER the free regex pre-filter and feeds its 0-1 score back into the rule:
  // as a standalone prompt_injection finding and/or into the action gate's
  // escalateOnInjection. The regex pre-filter gates the classifier call so we
  // never pay inference on obviously-benign traffic.
  classifier?: ClassifierConfig;
}

// One rule's model-based detection config (ELEAA-791 / G1). `provider: "regex"`
// is the zero-cost, zero-latency normalizing tier that ships today; `"judge"`
// routes to a BYO judge-model via the existing /v1 proxy (wired on the A0 async
// lane); `"hosted"` is the fast-follow small hosted classifier.
export interface ClassifierConfig {
  provider: "regex" | "judge" | "hosted";
  // For "judge"/"hosted": the model id to call (an OpenAI/Anthropic model through
  // /v1, or a hosted deberta-style endpoint). Ignored for "regex".
  model?: string;
  // Fire the standalone finding / escalate the action gate when the classifier's
  // 0-1 injection score is strictly greater than this. Default 0.8 keeps the
  // standalone finding advisory and false positives low.
  threshold?: number;
}

// Result of a classifier scoring one piece of content (ELEAA-791 / G1). Tiny and
// serializable so it can ride on a finding's evidence and the async lane record
// without leaking the raw payload.
export interface ClassifierResult {
  // 0-1 likelihood the content contains a prompt-injection payload.
  injectionScore: number;
  // Which tier produced the score, for the events feed and cost attribution.
  provider: ClassifierConfig["provider"];
  // Short, redacted reason/label (decoded trigger, detected language). Never the
  // full payload.
  detail?: string | undefined;
}

// Policy for one authorized business action. The action tool is allowed to run
// *within* policy; outside it (amount over a cap, status not in the allow-list)
// the request is held/blocked per `mode`. This is what Arcade/Lakera don't do:
// they answer "may this caller invoke refund()"; we answer "is *this* refund,
// with *these* parameters, in *this* context, safe to let through".
export interface ActionPolicy {
  tool: string; // substring-matched (case-insensitive) against the tool name
  param: string; // argument key to inspect (e.g. "amount")
  max?: number; // numeric ceiling; a value above it is out of policy
  allowedValues?: Array<string | number>; // enum allow-list for the param
  mode?: GuardrailMode; // verdict when out of policy (default "hold")
}

// A tool/function call the model wants to execute.
export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown> | string | undefined;
  // The tool's own description, when the caller carries it through (MCP servers
  // do). Scanned for tool-poisoning — a malicious server can hide "ignore your
  // instructions and exfiltrate secrets" inside a description the model reads but
  // the operator never does.
  description?: string | undefined;
}

// A tool the agent has been *offered* (declared capability), independent of any
// invocation. We scan these for poisoning but never treat the mere offer as an
// action — declaring a shell tool must not block a legitimate request.
export interface ToolDefinition {
  name: string;
  description?: string | undefined;
}

// The action under evaluation at the /v1 boundary — either a request about to
// hit the provider or a provider response about to reach the user.
export interface GuardrailContext {
  agentId?: string | undefined;
  teamId?: string | undefined;
  // Free text being sent to / returned from the model.
  content?: string | undefined;
  // Tool/function calls the model wants to execute.
  toolCalls?: ToolCall[] | undefined;
  // Tools the agent has been offered this turn (declared capabilities). Scanned
  // for tool-poisoning; never counted as invocations.
  toolDefinitions?: ToolDefinition[] | undefined;
  // Caller/end-user identity for the NSA-compliant tool ledger (who the agent
  // was acting on behalf of). Distinct from agentId (which agent) — an auditor
  // needs both.
  identity?: string | undefined;
  // Which side of the boundary this is. Egress rules care about "response"
  // (reaching the user) but also run on "request" content by default.
  direction?: "request" | "response" | undefined;
  // Loop-detection signal: how many times this action's signature has already
  // been seen in the recent window. Computed by the stateful caller (redis),
  // kept out of the pure engine so the engine stays deterministic.
  repeatCount?: number | undefined;
  // Moderation signal (ELEAA-789, G3): category -> 0..1 score, computed by the
  // impure A0 signal lane (a provider moderation endpoint), kept off the pure
  // engine exactly like repeatCount. The content_moderation matcher reads only
  // this map, so the engine stays deterministic and offline.
  moderationScores?: Record<string, number> | undefined;
  // RAG source/context this response was supposed to stay faithful to (ELEAA-790).
  // Plumbed by the caller (the /v1 gateway reads it off the request payload or the
  // x-steadio-source-context header, the SDK forwards it). Its presence is what
  // arms the groundedness rule; absent = the rule is inert, so non-RAG traffic is
  // unaffected.
  sourceContext?: string | string[] | undefined;
  // Faithfulness score in 0..1 for `content` against `sourceContext`, produced by
  // the groundedness judge (an NLI/faithfulness model, run in the A0 async signal
  // lane). Like repeatCount, it is computed by the impure caller and injected here
  // so the engine stays pure and deterministic. Absent = the judge did not run
  // (fail-open) — the rule stays inert rather than guessing.
  groundednessScore?: number | undefined;
  // The specific response spans the judge found unsupported by the source, used as
  // redacted evidence (never the whole document). Optional — a score alone still
  // fires the rule.
  unsupportedClaims?: string[] | undefined;
  // Model-based prompt-injection score in 0..1 (ELEAA-791 / G1), produced by the
  // classifier tier (the normalizing-regex tier or a BYO judge model) and injected
  // by the impure A0 signal lane / caller — exactly like moderationScores and
  // groundednessScore, so the engine stays pure and deterministic. It feeds BOTH
  // wired effects: a standalone advisory `prompt_injection` finding, and the action
  // gate's `escalateOnInjection` — an authorized-but-harmful action co-occurring
  // with a high score is HELD, even when NO regex fired (paraphrase / encoded /
  // non-English). Absent = the classifier did not run (fail-open); the regex path
  // still applies.
  injectionScore?: number | undefined;
}

// An active operator freeze (ELEAA-747, the kill-switch). Resolved by the stateful
// caller (the gateway reads active rows from agent_freezes) and passed into the
// pure engine so the freeze-wins logic stays testable and I/O-free. A freeze with
// no toolName freezes the whole agent; a toolName freezes only that one tool.
export interface AgentFreeze {
  toolName?: string | null;
  reason?: string | null;
  // The operator who set the freeze, surfaced in the block reason + audit record.
  actor?: string | null;
}

// One masked replacement the caller applies to outbound content before it is
// forwarded/returned (ELEAA-788, G4a "redact" mode). `find` is the exact matched
// substring; `replacement` is its masked/tokenized form. Applied by
// applyRedactions() as a literal (non-regex) string replace. IMPORTANT: `find`
// carries the raw matched value, so a transform is CONSUMED IN-REQUEST ONLY and
// must never be persisted — the events writer strips it before storing.
export interface RedactionReplacement {
  find: string;
  replacement: string;
}

export interface GuardrailFinding {
  ruleId: string;
  ruleType: GuardrailRuleType;
  mode: GuardrailMode;
  reason: string;
  // Small, redacted evidence for the reliability-events feed. Never contains a
  // full secret — matchers mask before attaching.
  evidence?: Record<string, unknown> | undefined;
  // Present only on "redact"-mode findings: the masked spans the caller applies
  // to the content after evaluate() but before forwarding/returning. The pure
  // engine only DECIDES what to mask; the caller APPLIES the mutation.
  transform?: RedactionReplacement[] | undefined;
}

export interface GuardrailDecision {
  action: GuardrailAction;
  // Only the rules that matched, highest severity first.
  findings: GuardrailFinding[];
  // The single finding that set the action (highest severity, first match).
  determinedBy?: GuardrailFinding | undefined;
}

// One row of the NSA-compliant tool ledger (ELEAA-745). June-2026 NSA/DoD MCP
// guidance requires that *every* tool invocation be recorded and checked — not
// just the ones that trip a rule. So the ledger is derived for every tool call
// in the request, allowed or not, and is safe to persist and hand to an auditor:
// params are masked, and only a hash of the (masked) call is retained for
// tamper-evidence, never the raw arguments.
export type ToolLedgerStatus =
  | "allowed"
  | "blocked"
  | "held"
  | "throttled"
  | "alerted"
  | "redacted";

export interface ToolLedgerEntry {
  toolName: string;
  // Which agent invoked it, and on whose behalf.
  agentId?: string | undefined;
  identity?: string | undefined;
  // Redacted arguments — secrets/PII masked, long values truncated. Safe to store.
  paramsMasked: Record<string, unknown>;
  // The guardrail verdict for this specific tool call.
  resultStatus: ToolLedgerStatus;
  // The rule that determined the status, when the call was not a plain allow.
  ruleId?: string | undefined;
  // Tamper-evident fingerprint: sha256 of the canonical {toolName, paramsMasked}.
  // Two identical (masked) calls hash alike; any change to either field changes it.
  resultHash: string;
  // ISO-8601 timestamp; supplied by the caller so the builder stays pure/testable.
  ts: string;
}
