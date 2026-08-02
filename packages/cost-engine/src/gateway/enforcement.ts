import { BudgetExceededError, RunawayDetectedError } from "@steadio/shared";
import { runawayEvents } from "@steadio/shared/schema";
import { getDb } from "../db.js";

type ErrorContext = {
  json(body: unknown, status?: number): Response;
  header(name: string, value: string): void;
};

function secondsUntil(isoTimestamp: string | undefined): number {
  if (!isoTimestamp) return 300;
  return Math.max(0, Math.ceil((new Date(isoTimestamp).getTime() - Date.now()) / 1000));
}

export function handleEnforcementError(
  c: ErrorContext,
  err: unknown,
  agentId: string,
  teamId: string,
): Response {
  if (err instanceof BudgetExceededError) {
    const retryAfter = secondsUntil(err.resetAt);
    c.header("Retry-After", String(retryAfter));
    return c.json(
      {
        error: "rate_limit_exceeded",
        message: "Budget limit reached for this period.",
        agent_id: agentId,
        budget_id: err.budgetId,
        retry_after: retryAfter,
        reset_at: err.resetAt ?? null,
      },
      429,
    );
  }
  if (err instanceof RunawayDetectedError) {
    const retryAfter = secondsUntil(err.cooldownUntil);
    c.header("Retry-After", String(retryAfter));
    void persistRunawayEvent(agentId, teamId, err);
    return c.json(
      {
        error: "rate_limit_exceeded",
        message: "Runaway agent detected. Request blocked during cooldown.",
        agent_id: agentId,
        trigger_type: err.triggerType,
        retry_after: retryAfter,
        cooldown_until: err.cooldownUntil ?? null,
      },
      429,
    );
  }
  throw err;
}

async function persistRunawayEvent(
  agentId: string,
  teamId: string,
  err: RunawayDetectedError,
): Promise<void> {
  try {
    await getDb().insert(runawayEvents).values({
      agentId,
      teamId,
      triggerType: err.triggerType,
      evidence: err.evidence ?? {},
      actionTaken: "circuit_break",
      cooldownUntil: err.cooldownUntil ? new Date(err.cooldownUntil) : null,
    });
  } catch (e) {
    console.error("[proxy] failed to persist runaway event:", e);
  }
}
