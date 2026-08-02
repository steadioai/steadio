// Approval-request persistence + hold notification (ELEAA-664, Track D).
//
// The human-in-the-loop queue: a "hold" guardrail verdict creates a pending row
// here instead of executing the action, notifies operators, and hands the caller
// a resume token. Operators approve/deny; the agent resumes with the token.

import { randomUUID } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { approvalRequests } from "@steadio/shared/schema";
import type { GuardrailDecision } from "../guardrails/types.js";

export interface HeldActionPayload {
  direction?: string | undefined;
  content?: string | undefined;
  toolCalls?: unknown;
}

export interface CreateApprovalInput {
  teamId: string;
  agentId?: string | undefined;
  keyId?: string | undefined;
  decision: GuardrailDecision;
  actionPayload: HeldActionPayload;
  contentPreview?: string | undefined;
  guardrailEventId?: string | undefined;
}

export interface ApprovalRow {
  id: string;
  teamId: string;
  agentId: string | null;
  keyId: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  ruleId: string;
  ruleType: string;
  reason: string;
  actionPayload: unknown;
  findings: unknown;
  contentPreview: string | null;
  resumeToken: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Create a pending approval for a held action. Returns the row (incl. the
// resumeToken — the caller returns this to the held agent, nothing else does).
export async function createApprovalRequest(
  input: CreateApprovalInput,
): Promise<ApprovalRow> {
  const det = input.decision.determinedBy;
  const resumeToken = `apr_${randomUUID().replace(/-/g, "")}`;
  const rows = await getDb()
    .insert(approvalRequests)
    .values({
      teamId: input.teamId,
      agentId: input.agentId ?? null,
      keyId: input.keyId ?? null,
      status: "pending",
      ruleId: det?.ruleId ?? "unknown",
      ruleType: det?.ruleType ?? "unknown",
      reason: det?.reason ?? "Action held for human approval",
      actionPayload: input.actionPayload as Record<string, unknown>,
      findings: input.decision.findings as unknown[],
      contentPreview: input.contentPreview?.slice(0, 512) ?? null,
      guardrailEventId: input.guardrailEventId ?? null,
      resumeToken,
    })
    .returning();
  return rows[0] as ApprovalRow;
}

// Stub: notification delivery is hosted-only. OSS logs and returns.
export async function notifyHold(approval: ApprovalRow): Promise<void> {
  console.log(`Hold notification: ${approval.id}`);
}

export async function listApprovals(
  teamId: string,
  opts?: { status?: string; limit?: number },
): Promise<ApprovalRow[]> {
  const conditions = [eq(approvalRequests.teamId, teamId)];
  const status = opts?.status;
  if (status && ["pending", "approved", "denied", "expired"].includes(status)) {
    conditions.push(
      eq(approvalRequests.status, status as ApprovalRow["status"]),
    );
  }
  const rows = await getDb()
    .select()
    .from(approvalRequests)
    .where(and(...conditions))
    .orderBy(desc(approvalRequests.createdAt))
    .limit(Math.min(opts?.limit ?? 100, 200));
  return rows as ApprovalRow[];
}

export async function countApprovals(
  teamId: string,
  status?: string,
): Promise<number> {
  const conditions = [eq(approvalRequests.teamId, teamId)];
  if (status && ["pending", "approved", "denied", "expired"].includes(status)) {
    conditions.push(
      eq(approvalRequests.status, status as ApprovalRow["status"]),
    );
  }
  const rows = await getDb()
    .select({ value: count() })
    .from(approvalRequests)
    .where(and(...conditions));
  return rows[0]?.value ?? 0;
}

export async function getApproval(
  id: string,
): Promise<ApprovalRow | undefined> {
  const rows = await getDb()
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  return rows[0] as ApprovalRow | undefined;
}

export async function getApprovalByResumeToken(
  token: string,
): Promise<ApprovalRow | undefined> {
  const rows = await getDb()
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.resumeToken, token))
    .limit(1);
  return rows[0] as ApprovalRow | undefined;
}

// Mark an approved resume token as spent. The status predicate keeps the consume
// operation one-time even when two resume attempts race with the same token.
export async function consumeApprovalResumeToken(
  id: string,
): Promise<ApprovalRow | undefined> {
  const rows = await getDb()
    .update(approvalRequests)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.status, "approved"),
      ),
    )
    .returning();
  return rows[0] as ApprovalRow | undefined;
}

// Approve or deny a pending request. Idempotent-ish: only transitions from
// "pending"; a second resolve returns the already-resolved row unchanged.
export async function resolveApproval(
  id: string,
  status: "approved" | "denied",
  resolvedBy: string,
  note?: string,
): Promise<ApprovalRow | undefined> {
  const existing = await getApproval(id);
  if (!existing) return undefined;
  if (existing.status !== "pending") return existing;

  const rows = await getDb()
    .update(approvalRequests)
    .set({
      status,
      resolvedBy,
      resolvedAt: new Date(),
      resolutionNote: note ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning();
  return (rows[0] as ApprovalRow | undefined) ?? existing;
}

export async function listPendingForQueue(teamId: string): Promise<ApprovalRow[]> {
  const rows = await getDb()
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.teamId, teamId), eq(approvalRequests.status, "pending")))
    .orderBy(approvalRequests.createdAt)
    .limit(500);
  return rows as ApprovalRow[];
}
