// Persistence service for guardrail events (ELEAA-640, Day 2).
//
// Writes a guardrail_event row for every non-allow decision emitted by the
// inline /v1 engine. Called fire-and-forget from the gateway: errors are
// logged and swallowed — a persist failure must never block the request path.

import { getDb } from "../db.js";
import { guardrailEvents } from "@steadio/shared/schema";
import type { GuardrailDecision } from "../guardrails/types.js";

export interface GuardrailEventInput {
  teamId: string;
  agentId?: string | undefined;
  decision: GuardrailDecision;
  direction?: string | undefined;
  contentPreview?: string | undefined;
  httpStatus?: number | undefined;
  // Whether the verdict was actually enforced (paid) or recorded in monitor-only
  // mode (free/trial). Defaults to true to preserve prior enforced behavior.
  enforced?: boolean | undefined;
}

export async function writeGuardrailEvent(input: GuardrailEventInput): Promise<void> {
  const { teamId, agentId, decision, direction, contentPreview, httpStatus, enforced } = input;
  if (decision.action === "allow") return; // allow decisions are intentionally not persisted

  const det = decision.determinedBy;
  if (!det) return; // shouldn't happen for non-allow, but be defensive

  // A "redact" verdict (ELEAA-788) is non-terminal — the content was masked and
  // the request proceeded — but the guardrail_action DB enum has no "redact"
  // value and this ticket ships without a migration. Record it under the closest
  // enum value ("alert": advisory, request went through); the true mode is still
  // preserved in the findings JSON below.
  const dbAction: "alert" | "throttle" | "hold" | "block" =
    decision.action === "redact"
      ? "alert"
      : (decision.action as "alert" | "throttle" | "hold" | "block");

  // Strip `transform` before persisting: it carries the RAW matched value (`find`),
  // so a masked event never leaks the very PII/secret the redaction removed.
  const safeFindings = decision.findings.map((f) => {
    const copy = { ...f };
    delete copy.transform;
    return copy;
  });

  await getDb()
    .insert(guardrailEvents)
    .values({
      teamId,
      agentId: agentId ?? null,
      action: dbAction,
      ruleId: det.ruleId,
      ruleType: det.ruleType,
      reason: det.reason,
      evidence: (det.evidence ?? {}) as Record<string, unknown>,
      findings: safeFindings as unknown[],
      direction: direction ?? "request",
      contentPreview: contentPreview?.slice(0, 512) ?? null,
      httpStatus: httpStatus ?? null,
      enforced: enforced ?? true,
    });
}
