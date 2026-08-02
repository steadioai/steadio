import { and, eq, desc, ne, isNotNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { approvalRequests } from "@steadio/shared/schema";
import type { ApprovalRow } from "./approval-service.js";

export type Severity = "critical" | "high" | "medium" | "low";
export type DisplaySafeValue = string | number | boolean | null;
export type DiffChange = "added" | "removed" | "changed" | "unchanged";

export interface ParameterDiffRow {
  key: string;
  change: DiffChange;
  previous?: DisplaySafeValue | undefined;
  proposed?: DisplaySafeValue | undefined;
  complex?: boolean | undefined;
}

export interface ParameterDiff {
  status: "ready" | "no_baseline" | "not_available";
  baselineApprovalId?: string | undefined;
  baselineApprovedAt?: string | undefined;
  rows?: ParameterDiffRow[] | undefined;
}

export interface PolicyTraceEntry {
  policyId?: string | undefined;
  policyName?: string | undefined;
  reason?: string | undefined;
  observed?: string | undefined;
  expected?: string | undefined;
}

export interface DecisionContext {
  severity?: Severity | undefined;
  riskSummary: string;
  action?: { name?: string | undefined; targetIdentity?: string | undefined } | undefined;
  parameterDiff: ParameterDiff;
  policyTrace: PolicyTraceEntry[];
}

const MODE_TO_SEVERITY: Record<string, Severity> = {
  block: "critical",
  hold: "high",
  redact: "medium",
  throttle: "medium",
  alert: "low",
};

const RULE_TYPE_LABELS: Record<string, string> = {
  privileged_tool_call: "Privileged tool call policy",
  secret_egress: "Secret egress detection",
  pii_egress: "PII egress detection",
  prompt_injection: "Prompt injection detection",
  tool_poisoning: "Tool poisoning detection",
  runaway_loop: "Runaway loop detection",
  content_moderation: "Content moderation",
  groundedness: "Groundedness check",
};

function isDisplaySafe(v: unknown): v is DisplaySafeValue {
  if (v === null) return true;
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean";
}

function isScalarArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(isDisplaySafe);
}

const INTERNAL_KEYS = new Set([
  "direction",
  "model",
  "messages",
  "stream",
  "stream_options",
  "n",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "seed",
  "user",
  "tools",
  "tool_choice",
  "response_format",
  "service_tier",
]);

function extractToolAction(
  payload: Record<string, unknown> | undefined,
): { name?: string | undefined; targetIdentity?: string | undefined } | undefined {
  if (!payload) return undefined;
  const toolCalls = payload["toolCalls"] as
    | Array<{ name?: string; arguments?: Record<string, unknown> | string }>
    | undefined;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  const first = toolCalls[0];
  const name = first?.name;
  let targetIdentity: string | undefined;
  const args =
    typeof first?.arguments === "string"
      ? safeParse(first.arguments)
      : first?.arguments;
  if (args && typeof args === "object") {
    for (const k of ["orderId", "order_id", "id", "userId", "user_id", "accountId", "account_id", "target", "resource"]) {
      const v = (args as Record<string, unknown>)[k];
      if (v != null && (typeof v === "string" || typeof v === "number")) {
        targetIdentity = String(v);
        break;
      }
    }
  }
  return name ? { name, targetIdentity } : undefined;
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function extractToolArgs(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!payload) return null;
  const toolCalls = payload["toolCalls"] as
    | Array<{ arguments?: Record<string, unknown> | string }>
    | undefined;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const raw = toolCalls[0]?.arguments;
  if (!raw) return null;
  if (typeof raw === "string") return safeParse(raw);
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return null;
}

function buildDiffRows(
  baseline: Record<string, unknown> | null,
  proposed: Record<string, unknown> | null,
): ParameterDiffRow[] | null {
  if (!proposed) return null;
  const allKeys = new Set([
    ...Object.keys(proposed),
    ...(baseline ? Object.keys(baseline) : []),
  ]);
  const rows: ParameterDiffRow[] = [];
  for (const key of allKeys) {
    if (INTERNAL_KEYS.has(key)) continue;
    const pVal = proposed[key];
    const bVal = baseline?.[key];
    const pSafe = isDisplaySafe(pVal) || isScalarArray(pVal);
    const bSafe = baseline ? isDisplaySafe(bVal) || isScalarArray(bVal) : true;

    if (!pSafe || !bSafe) {
      const hasP = key in proposed;
      const hasB = baseline ? key in baseline : false;
      if (hasP || hasB) {
        rows.push({
          key,
          change: !hasB ? "added" : !hasP ? "removed" : "changed",
          complex: true,
        });
      }
      continue;
    }

    const pDisplay = isScalarArray(pVal) ? JSON.stringify(pVal) : (pVal as DisplaySafeValue);
    const bDisplay = baseline
      ? isScalarArray(bVal) ? JSON.stringify(bVal) : (bVal as DisplaySafeValue)
      : undefined;

    if (!baseline) {
      rows.push({ key, change: "added", proposed: pDisplay });
    } else if (!(key in proposed)) {
      rows.push({ key, change: "removed", previous: bDisplay });
    } else if (!(key in baseline)) {
      rows.push({ key, change: "added", proposed: pDisplay });
    } else if (JSON.stringify(pVal) === JSON.stringify(bVal)) {
      rows.push({ key, change: "unchanged", previous: bDisplay, proposed: pDisplay });
    } else {
      rows.push({ key, change: "changed", previous: bDisplay, proposed: pDisplay });
    }
  }
  return rows.length > 0 ? rows : null;
}

function buildRiskSummary(
  approval: ApprovalRow,
  action?: { name?: string | undefined; targetIdentity?: string | undefined },
): { severity?: Severity | undefined; summary: string } {
  const findings = Array.isArray(approval.findings) ? approval.findings : [];
  const determinant = findings[0] as
    | { mode?: string; ruleType?: string; reason?: string }
    | undefined;

  const mode = determinant?.mode ?? "";
  const severity = MODE_TO_SEVERITY[mode];
  const ruleLabel =
    RULE_TYPE_LABELS[approval.ruleType] ?? approval.ruleType;
  const reason = approval.reason || determinant?.reason || "";
  const actionStr = action?.name;

  if (!ruleLabel && !reason) {
    return { summary: "This action requires operator review before proceeding." };
  }

  const cause = reason || ruleLabel;
  const severityLabel = severity
    ? severity.charAt(0).toUpperCase() + severity.slice(1)
    : "Review required";

  const actionPhrase = actionStr ? ` for ${actionStr}` : "";
  return {
    severity,
    summary: `${severityLabel}: ${cause}${actionPhrase}; approval is required before proceeding.`,
  };
}

function buildPolicyTrace(approval: ApprovalRow): PolicyTraceEntry[] {
  const findings = Array.isArray(approval.findings) ? approval.findings : [];
  if (findings.length === 0) return [];

  return findings.map((f: unknown) => {
    const finding = f as {
      ruleId?: string;
      ruleType?: string;
      reason?: string;
      evidence?: Record<string, unknown>;
    };
    const evidence = finding.evidence;
    let observed: string | undefined;
    let expected: string | undefined;

    if (evidence) {
      if (evidence["value"] != null && evidence["max"] != null) {
        observed = `${evidence["param"] ?? "value"}=${String(evidence["value"])}`;
        expected = `max=${String(evidence["max"])}`;
      } else if (evidence["tool"]) {
        observed = `tool=${String(evidence["tool"])}`;
      } else if (evidence["injectionScore"] != null) {
        observed = `injectionScore=${String(evidence["injectionScore"])}`;
        if (evidence["threshold"] != null)
          expected = `threshold=${String(evidence["threshold"])}`;
      }
    }

    const entry: PolicyTraceEntry = {};
    if (finding.ruleId) entry.policyId = finding.ruleId;
    const pName = RULE_TYPE_LABELS[finding.ruleType ?? ""] ?? finding.ruleType;
    if (pName) entry.policyName = pName;
    if (finding.reason) entry.reason = finding.reason;
    if (observed) entry.observed = observed;
    if (expected) entry.expected = expected;
    return entry;
  });
}

export async function buildDecisionContext(
  approval: ApprovalRow,
): Promise<DecisionContext> {
  const payload = approval.actionPayload as Record<string, unknown> | undefined;
  const action = extractToolAction(payload);
  const { severity, summary } = buildRiskSummary(approval, action);
  const policyTrace = buildPolicyTrace(approval);

  const proposedArgs = extractToolArgs(payload);
  let parameterDiff: ParameterDiff;

  if (!proposedArgs) {
    parameterDiff = { status: "not_available" };
  } else {
    const baseline = await findBaseline(approval, action);
    if (!baseline) {
      const rows = buildDiffRows(null, proposedArgs);
      parameterDiff = {
        status: "no_baseline",
        rows: rows ?? undefined,
      };
    } else {
      const baselineArgs = extractToolArgs(
        baseline.actionPayload as Record<string, unknown> | undefined,
      );
      const rows = buildDiffRows(baselineArgs, proposedArgs);
      parameterDiff = {
        status: "ready",
        baselineApprovalId: baseline.id,
        baselineApprovedAt: baseline.resolvedAt?.toISOString() ?? baseline.createdAt.toISOString(),
        rows: rows ?? undefined,
      };
    }
  }

  return {
    ...(severity ? { severity } : {}),
    riskSummary: summary,
    ...(action ? { action } : {}),
    parameterDiff,
    policyTrace,
  };
}

async function findBaseline(
  approval: ApprovalRow,
  action?: { name?: string | undefined; targetIdentity?: string | undefined },
): Promise<ApprovalRow | null> {
  if (!action?.name) return null;

  try {
    const rows = await getDb()
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.teamId, approval.teamId),
          eq(approvalRequests.status, "approved"),
          ne(approvalRequests.id, approval.id),
        ),
      )
      .orderBy(desc(approvalRequests.resolvedAt), desc(approvalRequests.id))
      .limit(50);

    const toolName = action.name.toLowerCase();
    const candidates = (rows as ApprovalRow[]).filter((r) => {
      const rPayload = r.actionPayload as Record<string, unknown> | undefined;
      const rAction = extractToolAction(rPayload);
      if (!rAction?.name || rAction.name.toLowerCase() !== toolName) return false;
      if (action.targetIdentity && rAction.targetIdentity) {
        if (rAction.targetIdentity !== action.targetIdentity) return false;
      }
      return true;
    });

    return candidates[0] ?? null;
  } catch {
    return null;
  }
}
