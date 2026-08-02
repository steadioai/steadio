// Incident timeline + alerting (ELEAA-680, Track H).
//
// An "incident" is not a new detector or a second copy of every firing — it is a
// root-cause GROUPING over the guardrail_events already persisted by the Day-2
// engine (ELEAA-640). Each guardrail firing (block/hold/throttle/alert) is one
// event; an incident collapses the 50 near-identical firings of the SAME rule by
// the SAME agent into one auditable row ("one page per root cause, not 50"). This
// reuses the Track D notify plumbing (notifier.ts + alert_configs) for the page —
// no new schema, no double-write, no new detector.

import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb } from "../db.js";
import { guardrailEvents, alertConfigs } from "@steadio/shared/schema";
import { sendNotification, type NotifyChannel } from "./notifier.js";
import {
  ACTION_SEVERITY,
  type GuardrailAction,
  type GuardrailDecision,
} from "../guardrails/types.js";

// The event name teams opt an alert_config into to receive incident pages.
export const INCIDENT_EVENT = "guardrail_incident";

// Dashboard base URL for the "View incident" link in notifications.
const DASHBOARD_URL =
  process.env["DASHBOARD_URL"]?.replace(/\/$/, "") ?? "http://localhost:5173";

// A firing is de-duplicated into the incident it belongs to for this long. We
// page ONCE when an incident opens (first firing of a root cause in the window);
// subsequent firings of the same root cause are folded in silently so the on-call
// engineer gets one page per incident, not one per event.
const DEDUP_WINDOW_MS =
  (parseInt(process.env["INCIDENT_DEDUP_WINDOW_MIN"] ?? "30", 10) || 30) *
  60_000;

// The mask-safe firings we surface under an incident (bounded per incident).
export interface IncidentFiring {
  id: string;
  action: GuardrailAction;
  reason: string;
  direction: string;
  contentPreview: string | null;
  httpStatus: number | null;
  createdAt: string;
}

export interface Incident {
  // Stable root-cause id: `${agentId ?? "-"}:${ruleId}`.
  key: string;
  teamId: string;
  agentId: string | null;
  ruleId: string;
  ruleType: string;
  // The most-severe action seen across the grouped firings (block > hold > …).
  action: GuardrailAction;
  // The most recent firing's reason (the human-readable "what happened").
  reason: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  // Per-action breakdown across the grouped firings.
  actions: Record<string, number>;
  // Most-recent firings for the expanded view (bounded).
  recentFirings: IncidentFiring[];
}

interface EventRow {
  id: string;
  teamId: string;
  agentId: string | null;
  action: string;
  ruleId: string;
  ruleType: string;
  reason: string;
  direction: string;
  contentPreview: string | null;
  httpStatus: number | null;
  createdAt: Date;
}

export interface ListIncidentsOpts {
  agentId?: string | undefined;
  ruleId?: string | undefined;
  action?: string | undefined;
  // Max incidents (root-cause groups) returned. Default 50, hard cap 200.
  limit?: number | undefined;
  // How many raw events to scan before grouping. Default 1000, hard cap 5000.
  scanLimit?: number | undefined;
}

const FIRINGS_PER_INCIDENT = 20;

// Group the persisted guardrail_events for a team into root-cause incidents.
// Grouping is done in-process (not SQL GROUP BY) so we can compute severity,
// per-action breakdowns and a bounded firing timeline in one pass — the event
// volume per team is small and bounded by scanLimit.
export async function listIncidents(
  teamId: string,
  opts: ListIncidentsOpts = {},
): Promise<Incident[]> {
  const scanLimit = Math.min(opts.scanLimit ?? 1000, 5000);
  const conditions = [eq(guardrailEvents.teamId, teamId)];
  if (opts.agentId) conditions.push(eq(guardrailEvents.agentId, opts.agentId));
  if (
    opts.action &&
    ["alert", "throttle", "hold", "block"].includes(opts.action)
  ) {
    conditions.push(
      eq(
        guardrailEvents.action,
        opts.action as "alert" | "throttle" | "hold" | "block",
      ),
    );
  }

  const rows = (await getDb()
    .select()
    .from(guardrailEvents)
    .where(and(...conditions))
    .orderBy(desc(guardrailEvents.createdAt))
    .limit(scanLimit)) as EventRow[];

  const groups = new Map<string, Incident>();
  for (const row of rows) {
    if (opts.ruleId && row.ruleId !== opts.ruleId) continue;
    const key = `${row.agentId ?? "-"}:${row.ruleId}`;
    const createdAt = new Date(row.createdAt).toISOString();
    const action = row.action as GuardrailAction;

    let inc = groups.get(key);
    if (!inc) {
      // Rows arrive newest-first, so the first row of a group is the latest
      // firing — it sets the incident's headline reason and lastSeen.
      inc = {
        key,
        teamId: row.teamId,
        agentId: row.agentId,
        ruleId: row.ruleId,
        ruleType: row.ruleType,
        action,
        reason: row.reason,
        count: 0,
        firstSeen: createdAt,
        lastSeen: createdAt,
        actions: {},
        recentFirings: [],
      };
      groups.set(key, inc);
    }

    inc.count += 1;
    inc.actions[action] = (inc.actions[action] ?? 0) + 1;
    if (createdAt < inc.firstSeen) inc.firstSeen = createdAt;
    if (createdAt > inc.lastSeen) {
      inc.lastSeen = createdAt;
      inc.reason = row.reason;
    }
    // Track the most-severe action for the incident headline.
    if (ACTION_SEVERITY[action] > ACTION_SEVERITY[inc.action]) {
      inc.action = action;
    }
    if (inc.recentFirings.length < FIRINGS_PER_INCIDENT) {
      inc.recentFirings.push({
        id: row.id,
        action,
        reason: row.reason,
        direction: row.direction,
        contentPreview: row.contentPreview,
        httpStatus: row.httpStatus,
        createdAt,
      });
    }
  }

  const limit = Math.min(opts.limit ?? 50, 200);
  return Array.from(groups.values())
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
    .slice(0, limit);
}

export interface NotifyIncidentInput {
  teamId: string;
  agentId?: string | undefined;
  decision: GuardrailDecision;
  contentPreview?: string | undefined;
  httpStatus?: number | undefined;
}

// Page on a NEW incident. Called fire-and-forget from the gateway AFTER the
// firing has been persisted, so the de-dup count includes the current firing:
// count === 1 within the window means this firing just OPENED the incident, and
// only then do we page. Never throws — a failed page must not affect the request.
export async function notifyIncident(input: NotifyIncidentInput): Promise<void> {
  try {
    const det = input.decision.determinedBy;
    if (!det || input.decision.action === "allow") return;

    const db = getDb();

    // De-dup: is this the first firing of this root cause inside the window?
    const since = new Date(Date.now() - DEDUP_WINDOW_MS);
    const dedupConds = [
      eq(guardrailEvents.teamId, input.teamId),
      eq(guardrailEvents.ruleId, det.ruleId),
      gte(guardrailEvents.createdAt, since),
      input.agentId
        ? eq(guardrailEvents.agentId, input.agentId)
        : isNull(guardrailEvents.agentId),
    ];
    const recent = (await db
      .select({ id: guardrailEvents.id })
      .from(guardrailEvents)
      .where(and(...dedupConds))
      .limit(2)) as Array<{ id: string }>;
    // 0 = the persist hasn't landed yet (shouldn't happen — we run after it);
    // >1 = the incident is already open and was already paged. Only 1 pages.
    if (recent.length !== 1) return;

    const configs = await db
      .select()
      .from(alertConfigs)
      .where(eq(alertConfigs.teamId, input.teamId));
    const targets = configs.filter(
      (cfg) =>
        cfg.active && (cfg.enabledEvents as string[]).includes(INCIDENT_EVENT),
    );
    if (targets.length === 0) return;

    const agentLabel = input.agentId ?? "unknown";
    const msg = {
      event: INCIDENT_EVENT,
      title: `🚨 Incident opened — ${det.ruleType}`,
      summary: `Agent \`${agentLabel}\` tripped guardrail \`${det.ruleId}\`. ${det.reason}`,
      fields: [
        { label: "Agent", value: agentLabel },
        { label: "Rule", value: `${det.ruleType} (${det.ruleId})` },
        { label: "Verdict", value: input.decision.action },
        { label: "Reason", value: det.reason },
      ],
      actionUrl: `${DASHBOARD_URL}/incidents`,
      actionLabel: "View incident",
    };

    await Promise.allSettled(
      targets.map((cfg) =>
        sendNotification(cfg.webhookUrl!, cfg.channel as NotifyChannel, msg),
      ),
    );
  } catch (err) {
    console.error("[incident] notifyIncident error:", err);
  }
}
