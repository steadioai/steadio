import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { requireCapability, requireTeamAdmin } from "../middleware/management-auth.js";
import {
  countApprovals,
  getApproval,
  listApprovals,
  listPendingForQueue,
  resolveApproval,
  type ApprovalRow,
} from "../services/approval-service.js";
import { buildDecisionContext, type DecisionContext } from "../services/decision-context-service.js";
import { getDb } from "../db.js";
import { agents, apiKeys } from "@steadio/shared/schema";

// Management API for the human-in-the-loop approval queue (ELEAA-664, Track D).
// Requires a valid dashboard JWT; all reads/writes are team-scoped. The
// resumeToken is never returned here — it only ever goes back to the held caller
// at /v1 (a dashboard user approves; the agent, not the browser, resumes).
//
// Authorization (ELEAA-1188):
//   READ  (GET list/detail) — requires `joins:read` capability (admin/operator
//         roles satisfy this implicitly).
//   WRITE (POST approve/deny) — requires team admin role. The `joins:read`
//         capability alone does NOT grant approval authority.

export const approvalsRoutes = new Hono();

function serialize(
  row: ApprovalRow,
  agentName?: string | null,
  keyName?: string | null,
  decisionContext?: DecisionContext,
) {
  return {
    id: row.id,
    teamId: row.teamId,
    agentId: row.agentId,
    status: row.status,
    ruleId: row.ruleId,
    ruleType: row.ruleType,
    reason: row.reason,
    actionPayload: row.actionPayload,
    findings: row.findings,
    contentPreview: row.contentPreview,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(agentName ? { agentName } : {}),
    ...(keyName ? { keyName } : {}),
    ...(decisionContext ? { decisionContext } : {}),
  };
}

async function resolveNames(
  rows: ApprovalRow[],
  teamId: string,
): Promise<{ agentNames: Map<string, string>; keyNames: Map<string, string> }> {
  const agentIds = [...new Set(rows.map((r) => r.agentId).filter(Boolean))] as string[];
  const keyIds = [...new Set(rows.map((r) => r.keyId).filter(Boolean))] as string[];

  const agentNames = new Map<string, string>();
  const keyNames = new Map<string, string>();

  try {
    if (agentIds.length > 0) {
      const agentRows = await getDb()
        .select({ externalId: agents.externalId, name: agents.name })
        .from(agents)
        .where(eq(agents.teamId, teamId));
      for (const a of agentRows) {
        if (a.externalId) agentNames.set(a.externalId, a.name);
      }
    }
  } catch {
    // fail-open
  }

  try {
    if (keyIds.length > 0) {
      const keyRows = await getDb()
        .select({ id: apiKeys.id, name: apiKeys.name })
        .from(apiKeys)
        .where(inArray(apiKeys.id, keyIds));
      for (const k of keyRows) {
        keyNames.set(k.id, k.name);
      }
    }
  } catch {
    // fail-open
  }

  return { agentNames, keyNames };
}

// ---------------------------------------------------------------------------
// Held-request queue (ELEAA-1744) — server-filtered, priority-sorted queue.
// ---------------------------------------------------------------------------

interface QueueItem {
  id: string;
  status: "held";
  workspaceId: string;
  createdAt: string;
  actionName?: string | undefined;
  severity?: "critical" | "high" | "medium" | "low" | undefined;
  riskSummary?: string | undefined;
  policy?: { id?: string | undefined; name?: string | undefined } | undefined;
  canDecide: boolean;
}

const QUEUE_MODE_TO_SEVERITY: Record<string, "critical" | "high" | "medium" | "low"> = {
  block: "critical",
  hold: "high",
  redact: "medium",
  throttle: "medium",
  alert: "low",
};

const QUEUE_RULE_TYPE_LABELS: Record<string, string> = {
  privileged_tool_call: "Privileged tool call policy",
  secret_egress: "Secret egress detection",
  pii_egress: "PII egress detection",
  prompt_injection: "Prompt injection detection",
  tool_poisoning: "Tool poisoning detection",
  runaway_loop: "Runaway loop detection",
  content_moderation: "Content moderation",
  groundedness: "Groundedness check",
};

function extractActionName(row: ApprovalRow): string | undefined {
  const payload = row.actionPayload as Record<string, unknown> | undefined;
  const toolCalls = payload?.["toolCalls"] as Array<{ name?: string }> | undefined;
  if (Array.isArray(toolCalls) && toolCalls[0]?.name) return toolCalls[0].name;
  if (payload?.["direction"] === "response") return "content_egress";
  return undefined;
}

function toQueueItem(row: ApprovalRow): QueueItem {
  const actionName = extractActionName(row);
  const findings = Array.isArray(row.findings) ? row.findings : [];
  const determinant = findings[0] as { mode?: string; reason?: string } | undefined;
  const severity = determinant?.mode ? QUEUE_MODE_TO_SEVERITY[determinant.mode] : undefined;

  const ruleLabel = QUEUE_RULE_TYPE_LABELS[row.ruleType] ?? row.ruleType;
  const reason = row.reason || determinant?.reason || "";
  const severityLabel = severity
    ? severity.charAt(0).toUpperCase() + severity.slice(1)
    : "Review required";
  const actionPhrase = actionName ? ` for ${actionName}` : "";
  const riskSummary = reason
    ? `${severityLabel}: ${reason}${actionPhrase}; approval is required before proceeding.`
    : "This action requires operator review before proceeding.";

  return {
    id: row.id,
    status: "held",
    workspaceId: row.teamId,
    createdAt: row.createdAt.toISOString(),
    actionName,
    severity,
    riskSummary,
    policy: { id: row.ruleId !== "unknown" ? row.ruleId : undefined, name: ruleLabel },
    canDecide: true,
  };
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
function severityRank(s?: string): number {
  return s ? (SEVERITY_ORDER[s] ?? 4) : 4;
}

// GET /api/approvals/queue?teamId=&severity=&action=&policy=&age=&cursor=&limit=
approvalsRoutes.get("/queue", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireCapability(c, teamId, "joins:read");
  if (auth instanceof Response) return auth;

  const rows = await listPendingForQueue(teamId);
  const allItems = rows.map(toQueueItem);
  let items = [...allItems];

  const severityFilter = c.req.query("severity")?.split(",").filter(Boolean);
  if (severityFilter?.length) {
    items = items.filter((item) => severityFilter.includes(item.severity ?? "unknown"));
  }

  const actionFilter = c.req.query("action")?.split(",").filter(Boolean);
  if (actionFilter?.length) {
    items = items.filter((item) => item.actionName && actionFilter.includes(item.actionName));
  }

  const policyFilter = c.req.query("policy")?.split(",").filter(Boolean);
  if (policyFilter?.length) {
    items = items.filter((item) => item.policy?.id && policyFilter.includes(item.policy.id));
  }

  const ageFilter = c.req.query("age");
  if (ageFilter) {
    const now = Date.now();
    items = items.filter((item) => {
      const ageHours = (now - new Date(item.createdAt).getTime()) / 3_600_000;
      switch (ageFilter) {
        case "lt1h": return ageHours < 1;
        case "1to24h": return ageHours >= 1 && ageHours <= 24;
        case "gt24h": return ageHours > 24;
        default: return true;
      }
    });
  }

  const totalCount = items.length;

  items.sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    const time = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (time !== 0) return time;
    return a.id.localeCompare(b.id);
  });

  const cursor = c.req.query("cursor");
  if (cursor) {
    const idx = items.findIndex((i) => i.id === cursor);
    if (idx >= 0) items = items.slice(idx + 1);
  }

  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);
  const page = items.slice(0, limit);
  const nextCursor = page.length === limit && items.length > limit ? page[page.length - 1]!.id : undefined;

  const actions = [...new Set(allItems.map((i) => i.actionName).filter(Boolean))] as string[];
  const policyMap = new Map<string, { id: string; name: string }>();
  for (const i of allItems) {
    if (i.policy?.id) policyMap.set(i.policy.id, { id: i.policy.id, name: i.policy.name ?? i.policy.id });
  }
  const severities = [...new Set(allItems.map((i) => i.severity ?? "unknown"))].sort();

  return c.json({
    items: page,
    totalCount,
    ...(nextCursor ? { nextCursor } : {}),
    filters: { actions: actions.sort(), policies: [...policyMap.values()], severities },
  });
});

// GET /api/approvals?teamId=&status=&limit=
approvalsRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAdmin(c, teamId);
  if (auth instanceof Response) return auth;

  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const [rows, total, pendingCount] = await Promise.all([
    listApprovals(teamId, { ...(status ? { status } : {}), limit }),
    countApprovals(teamId, status || undefined),
    status === "pending" ? undefined : countApprovals(teamId, "pending"),
  ]);
  const resolvedPendingCount = status === "pending" ? total : (pendingCount ?? 0);
  const [{ agentNames, keyNames }, ...contexts] = await Promise.all([
    resolveNames(rows, teamId),
    ...rows.map((r) => buildDecisionContext(r).catch(() => undefined)),
  ]);
  return c.json({
    approvals: rows.map((r, i) =>
      serialize(r, r.agentId ? agentNames.get(r.agentId) : null, r.keyId ? keyNames.get(r.keyId) : null, contexts[i]),
    ),
    total,
    pendingCount: resolvedPendingCount,
  });
});

// GET /api/approvals/:id
approvalsRoutes.get("/:id", async (c) => {
  const row = await getApproval(c.req.param("id") ?? "");
  if (!row) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, row.teamId);
  if (auth instanceof Response) return auth;
  const [{ agentNames, keyNames }, decisionContext] = await Promise.all([
    resolveNames([row], row.teamId),
    buildDecisionContext(row).catch(() => undefined),
  ]);
  return c.json({
    approval: serialize(row, row.agentId ? agentNames.get(row.agentId) : null, row.keyId ? keyNames.get(row.keyId) : null),
    ...(decisionContext ? { decisionContext } : {}),
  });
});

const resolveSchema = z.object({ note: z.string().max(1000).optional() });

async function handleResolve(c: Context, next: "approved" | "denied") {
  const row = await getApproval(c.req.param("id") ?? "");
  if (!row) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, row.teamId);
  if (auth instanceof Response) return auth;

  if (row.status !== "pending") {
    return c.json(
      { error: "already_resolved", message: `Request is already ${row.status}.`, approval: serialize(row) },
      409,
    );
  }

  let note: string | undefined;
  try {
    const parsed = resolveSchema.safeParse(await c.req.json().catch(() => ({})));
    if (parsed.success) note = parsed.data.note;
  } catch {
    // no body is fine
  }

  const updated = await resolveApproval(row.id, next, auth.userId, note);
  return c.json({ approval: updated ? serialize(updated) : serialize(row) });
}

// POST /api/approvals/:id/approve  { note? }
approvalsRoutes.post("/:id/approve", (c) => handleResolve(c, "approved"));

// POST /api/approvals/:id/deny  { note? }
approvalsRoutes.post("/:id/deny", (c) => handleResolve(c, "denied"));

// ---------------------------------------------------------------------------
// Batch decision (ELEAA-1744) — idempotent batch approve/deny with audit.
// ---------------------------------------------------------------------------

const batchIdempotencyCache = new Map<string, { results: BatchResult[]; expiresAt: number }>();

interface BatchResult {
  approvalId: string;
  outcome: "approved" | "denied" | "unchanged" | "failed";
  code?: string | undefined;
  message?: string | undefined;
}

const batchSchema = z.object({
  approvalIds: z.array(z.string().min(1)).min(1).max(50),
  decision: z.enum(["approve", "deny"]),
  denialReason: z.string().min(1).max(500).optional(),
  idempotencyKey: z.string().min(1).max(128),
});

approvalsRoutes.post("/batch", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
  }

  const { approvalIds, decision, denialReason, idempotencyKey } = parsed.data;

  if (decision === "deny" && !denialReason) {
    return c.json({ error: "denial_reason_required", message: "A reason is required to deny requests." }, 400);
  }

  const cached = batchIdempotencyCache.get(idempotencyKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json({ results: cached.results, batchCorrelationId: idempotencyKey, replayed: true });
  }

  const userId = c.get("userId" as never) as string;
  const userTeamId = c.get("teamId" as never) as string;
  if (!userId || !userTeamId) return c.json({ error: "unauthorized" }, 401);

  const adminAuth = requireTeamAdmin(c, userTeamId);
  if (adminAuth instanceof Response) return adminAuth;

  const uniqueIds = [...new Set(approvalIds)];
  const fetched = await Promise.all(uniqueIds.map((id) => getApproval(id)));

  const results: BatchResult[] = [];
  const eligible: Array<{ id: string; row: ApprovalRow }> = [];
  let firstAction: string | undefined | null = null;
  let actionMismatch = false;

  for (let i = 0; i < uniqueIds.length; i++) {
    const id = uniqueIds[i]!;
    const row = fetched[i];

    if (!row) {
      results.push({ approvalId: id, outcome: "failed", code: "NOT_FOUND", message: "Approval not found" });
      continue;
    }

    if (row.teamId !== userTeamId) {
      return c.json({
        error: "mixed_workspace",
        message: "All approvals in a batch must belong to the same workspace.",
        results: uniqueIds.map((uid) => ({
          approvalId: uid, outcome: "failed" as const, code: "MIXED_WORKSPACE" as const, message: "Mixed workspace batch rejected",
        })),
      }, 400);
    }

    if (row.status !== "pending") {
      results.push({ approvalId: id, outcome: "unchanged", code: "NOT_HELD", message: `Already ${row.status}` });
      continue;
    }

    const actionName = extractActionName(row);
    if (firstAction === null) {
      firstAction = actionName;
    } else if (firstAction !== actionName) {
      actionMismatch = true;
    }

    eligible.push({ id, row });
  }

  if (actionMismatch) {
    return c.json({
      error: "mixed_action",
      message: "All approvals in a batch must have the same action type.",
      results: uniqueIds.map((uid) => ({
        approvalId: uid, outcome: "failed" as const, code: "MIXED_ACTION" as const, message: "Mixed action batch rejected",
      })),
    }, 400);
  }

  const status = decision === "approve" ? "approved" as const : "denied" as const;
  const batchNote = denialReason
    ? `${denialReason} [batch:${idempotencyKey}]`
    : `[batch:${idempotencyKey}]`;

  for (const { id } of eligible) {
    try {
      const resolved = await resolveApproval(id, status, userId, batchNote);
      if (resolved && resolved.status === status) {
        results.push({ approvalId: id, outcome: status });
      } else {
        results.push({ approvalId: id, outcome: "unchanged", code: "NOT_HELD", message: `Already ${resolved?.status ?? "resolved"}` });
      }
    } catch {
      results.push({ approvalId: id, outcome: "failed", code: "UNKNOWN", message: "Failed to resolve" });
    }
  }

  batchIdempotencyCache.set(idempotencyKey, { results, expiresAt: Date.now() + 300_000 });
  if (batchIdempotencyCache.size > 100) {
    const now = Date.now();
    for (const [key, entry] of batchIdempotencyCache) {
      if (entry.expiresAt <= now) batchIdempotencyCache.delete(key);
    }
  }

  return c.json({ results, batchCorrelationId: idempotencyKey });
});
