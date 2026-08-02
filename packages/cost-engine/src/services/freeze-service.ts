// Kill-switch persistence + audit (ELEAA-747).
//
// An operator freezes an agent (or one tool for an agent); the /v1 gateway reads
// the active freezes for that agent on every call and blocks inline while any
// apply (see guardrails/engine.ts matchFreeze). This service owns the freeze
// state (agent_freezes) and the audit trail: every freeze / unfreeze writes a
// guardrail_events row so the change is visible in the same feed + incident view
// as the blocked calls it causes, with the acting operator + reason.
//
// Freeze is keyed on the external agent identifier the gateway sees on the
// x-steadio-agent-id header — the same id guardrail_events / incidents group on —
// so a dashboard freeze and a live gateway call line up by construction.

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { agentFreezes } from "@steadio/shared/schema";
import { writeGuardrailEvent } from "./guardrail-event-service.js";
import type { AgentFreeze } from "../guardrails/types.js";

export interface FreezeRow {
  id: string;
  teamId: string;
  agentId: string;
  toolName: string | null;
  active: boolean;
  reason: string | null;
  actorUserId: string | null;
  clearedBy: string | null;
  clearedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Normalize an empty/whitespace tool name to null (= whole-agent freeze) so
// "freeze whole agent" and "freeze tool ''" can't diverge.
function normTool(toolName?: string | null): string | null {
  const t = (toolName ?? "").trim();
  return t.length ? t : null;
}

// The active freezes for one agent, shaped for the pure engine's matchFreeze.
export async function getActiveFreezes(
  teamId: string,
  agentId: string,
): Promise<AgentFreeze[]> {
  const rows = (await getDb()
    .select()
    .from(agentFreezes)
    .where(
      and(
        eq(agentFreezes.teamId, teamId),
        eq(agentFreezes.agentId, agentId),
        eq(agentFreezes.active, true),
      ),
    )) as FreezeRow[];
  return rows.map((r) => ({
    toolName: r.toolName,
    reason: r.reason,
    actor: r.actorUserId,
  }));
}

// Every currently-active freeze for a team (dashboard list).
export async function listActiveFreezes(teamId: string): Promise<FreezeRow[]> {
  return (await getDb()
    .select()
    .from(agentFreezes)
    .where(
      and(eq(agentFreezes.teamId, teamId), eq(agentFreezes.active, true)),
    )
    .orderBy(desc(agentFreezes.createdAt))) as FreezeRow[];
}

function matchesScope(row: FreezeRow, toolName: string | null): boolean {
  return (row.toolName ?? null) === toolName;
}

export interface SetFreezeInput {
  teamId: string;
  agentId: string;
  toolName?: string | null;
  reason?: string | null;
  actorUserId?: string | null;
}

// Freeze an agent or a single tool. Idempotent per (team, agent, tool scope):
// re-freezing the same scope refreshes the existing active row rather than
// stacking duplicates. Writes an audit guardrail_events row (block, kill_switch).
export async function setFreeze(input: SetFreezeInput): Promise<FreezeRow> {
  const toolName = normTool(input.toolName);
  const db = getDb();

  const existing = (await db
    .select()
    .from(agentFreezes)
    .where(
      and(
        eq(agentFreezes.teamId, input.teamId),
        eq(agentFreezes.agentId, input.agentId),
        eq(agentFreezes.active, true),
      ),
    )) as FreezeRow[];
  const current = existing.find((r) => matchesScope(r, toolName));

  let row: FreezeRow;
  if (current) {
    const updated = (await db
      .update(agentFreezes)
      .set({
        reason: input.reason ?? null,
        actorUserId: input.actorUserId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(agentFreezes.id, current.id))
      .returning()) as FreezeRow[];
    row = updated[0]!;
  } else {
    const inserted = (await db
      .insert(agentFreezes)
      .values({
        teamId: input.teamId,
        agentId: input.agentId,
        toolName,
        active: true,
        reason: input.reason ?? null,
        actorUserId: input.actorUserId ?? null,
      })
      .returning()) as FreezeRow[];
    row = inserted[0]!;
  }

  await writeFreezeAudit(row, "freeze", input.actorUserId ?? null);

  return row;
}

export interface ClearFreezeInput {
  teamId: string;
  agentId: string;
  toolName?: string | null;
  actorUserId?: string | null;
}

// Unfreeze an agent or a single tool. Returns the cleared rows (empty if the
// scope was not frozen). Writes an audit guardrail_events row (alert, kill_switch)
// so the resume is visible in the same feed as the freeze.
export async function clearFreeze(input: ClearFreezeInput): Promise<FreezeRow[]> {
  const toolName = normTool(input.toolName);
  const db = getDb();

  const active = (await db
    .select()
    .from(agentFreezes)
    .where(
      and(
        eq(agentFreezes.teamId, input.teamId),
        eq(agentFreezes.agentId, input.agentId),
        eq(agentFreezes.active, true),
      ),
    )) as FreezeRow[];
  const targets = active.filter((r) => matchesScope(r, toolName));
  if (targets.length === 0) return [];

  const cleared: FreezeRow[] = [];
  for (const t of targets) {
    const rows = (await db
      .update(agentFreezes)
      .set({
        active: false,
        clearedBy: input.actorUserId ?? null,
        clearedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentFreezes.id, t.id))
      .returning()) as FreezeRow[];
    if (rows[0]) {
      cleared.push(rows[0]);
      await writeFreezeAudit(rows[0], "unfreeze", input.actorUserId ?? null);
    }
  }
  return cleared;
}

// Audit record for a freeze/unfreeze administrative action. A freeze is recorded
// as a block (it's a hard stop taking effect); an unfreeze as an alert (an
// informational state change). Both carry the actor + reason and share the
// kill_switch rule id so they group with the blocked-by-freeze call events.
async function writeFreezeAudit(
  row: FreezeRow,
  event: "freeze" | "unfreeze",
  actor: string | null,
): Promise<void> {
  const scope = row.toolName ? `tool "${row.toolName}"` : "agent";
  const verb = event === "freeze" ? "frozen" : "unfrozen";
  const who = actor ? ` by ${actor}` : "";
  const why = row.reason && event === "freeze" ? ` — ${row.reason}` : "";
  const action = event === "freeze" ? "block" : "alert";
  try {
    await writeGuardrailEvent({
      teamId: row.teamId,
      agentId: row.agentId,
      decision: {
        action,
        findings: [],
        determinedBy: {
          ruleId: "kill_switch",
          ruleType: "kill_switch",
          mode: action === "block" ? "block" : "alert",
          reason: `Kill-switch ${event}: ${scope} ${verb}${who}${why}.`,
          evidence: {
            killSwitch: true,
            event,
            scope: row.toolName ? "tool" : "agent",
            ...(row.toolName ? { toolName: row.toolName } : {}),
            ...(actor ? { actor } : {}),
            ...(row.reason ? { freezeReason: row.reason } : {}),
          },
        },
      },
      direction: "control",
      contentPreview: `${event} ${scope}`,
      enforced: true,
    });
  } catch (err) {
    // The audit write must never fail the freeze/unfreeze operation itself.
    console.error("[freeze] audit write error:", err);
  }
}
