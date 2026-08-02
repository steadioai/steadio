// Continuous Reliability Check — history + regression detection (ELEAA-746, F3).
//
// Runs the SAME attack pack the self-serve demo uses (against the SAME engine
// /v1 enforces) on a schedule, persists one scored snapshot per team over time,
// and fires an existing alert channel (webhook/Slack) when a team's safety
// posture REGRESSES between runs — a letter-grade drop or a previously-covered
// attack category that now lands. That turns the one-shot demo into a retention
// feature: "tell me when my posture regresses, automatically."
//
// The rule set is global today (DEFAULT_RULES); the snapshot/history/alert
// mechanism is what F3 adds. The moment rules become per-team or the attack pack
// grows, this surface already reports the delta — no rework. A live "point at
// your own endpoint" prober is intentionally NOT built here (SSRF; see the
// reliability-check route's note).

import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { reliabilitySnapshots, alertConfigs } from "@steadio/shared/schema";
import { DEFAULT_RULES } from "../guardrails/rules.js";
import {
  runReliabilityCheck,
  unprotectedExposure,
  ATTACK_PACK,
  type AttackCase,
  type ReliabilityReport,
} from "../guardrails/attack-pack.js";
import type { GuardrailRule } from "../guardrails/types.js";
import { sendNotification, type NotifyChannel } from "./notifier.js";

// The event an alert_config opts into to receive reliability regression pages.
export const RELIABILITY_REGRESSION_EVENT = "reliability_regression";

const DASHBOARD_URL =
  process.env["DASHBOARD_URL"]?.replace(/\/$/, "") ?? "http://localhost:5173";

// Letter grades from best to worst — a higher index is a worse posture.
const GRADE_ORDER = ["A", "B", "C", "D", "F"] as const;
type Grade = (typeof GRADE_ORDER)[number];

function gradeRank(grade: string): number {
  const i = GRADE_ORDER.indexOf(grade as Grade);
  // Unknown grades sort worst so we never miss a drop.
  return i === -1 ? GRADE_ORDER.length : i;
}

// A category is "landing" when at least one attack in it is no longer caught.
function landingCategories(byCategory: CategorySummary[]): Set<string> {
  return new Set(
    byCategory.filter((c) => c.caught < c.attacks).map((c) => c.category),
  );
}

export interface CategorySummary {
  category: string;
  attacks: number;
  caught: number;
}

// The comparable shape of a snapshot — what regression detection needs. Works
// for both a freshly-computed report and a row loaded from history.
export interface SnapshotLike {
  score: number;
  grade: string;
  byCategory: CategorySummary[];
}

export interface RegressionResult {
  isRegression: boolean;
  gradeDropped: boolean;
  scoreDelta: number;
  // Categories that catch an attack in `prev` but let one land in `curr` (newly
  // landing), plus categories absent in `prev` that land in `curr`.
  newlyLandingCategories: string[];
  reason: string | null;
}

// Pure: compare the current snapshot to the previous one. A regression is a
// grade drop OR an attack category that now lands and didn't before. A score
// dip that stays inside the same grade band is reported (scoreDelta) but does
// NOT page on its own — grade bands are the meaningful posture threshold.
export function detectRegression(
  prev: SnapshotLike | null,
  curr: SnapshotLike,
): RegressionResult {
  if (!prev) {
    // First-ever snapshot: nothing to regress against — establish the baseline.
    return {
      isRegression: false,
      gradeDropped: false,
      scoreDelta: 0,
      newlyLandingCategories: [],
      reason: null,
    };
  }

  const gradeDropped = gradeRank(curr.grade) > gradeRank(prev.grade);
  const prevLanding = landingCategories(prev.byCategory);
  const currLanding = landingCategories(curr.byCategory);
  const newlyLanding = [...currLanding].filter((c) => !prevLanding.has(c));

  const isRegression = gradeDropped || newlyLanding.length > 0;

  const parts: string[] = [];
  if (gradeDropped) parts.push(`grade dropped ${prev.grade} → ${curr.grade}`);
  if (newlyLanding.length > 0) {
    parts.push(
      `new attack ${newlyLanding.length === 1 ? "category" : "categories"} landing: ${newlyLanding.join(", ")}`,
    );
  }

  return {
    isRegression,
    gradeDropped,
    scoreDelta: curr.score - prev.score,
    newlyLandingCategories: newlyLanding,
    reason: parts.length ? parts.join("; ") : null,
  };
}

export interface SnapshotRow {
  id: string;
  teamId: string;
  agentId: string | null;
  score: number;
  grade: string;
  attacksTotal: number;
  attacksCaught: number;
  controlsTotal: number;
  falsePositives: number;
  unprotectedExposure: number;
  byCategory: CategorySummary[];
  source: string;
  regression: boolean;
  regressionReason: string | null;
  createdAt: Date;
}

function reportToCategories(report: ReliabilityReport): CategorySummary[] {
  return report.byCategory.map((c) => ({
    category: String(c.category),
    attacks: c.attacks,
    caught: c.caught,
  }));
}

export interface RecordSnapshotOpts {
  agentId?: string | undefined;
  source?: "cron" | "manual";
  // Rule set to score against; defaults to the live DEFAULT_RULES the gateway
  // enforces. Injectable so a future per-team config can be threaded through.
  rules?: GuardrailRule[];
  pack?: AttackCase[];
}

export interface RecordSnapshotResult {
  snapshot: SnapshotRow;
  regression: RegressionResult;
  notified: number;
}

// Scope a snapshot read to one team, optionally to one agent. When no agentId is
// given the read is team-wide and MUST exclude agent-scoped rows (agent_id IS
// NULL) — otherwise a recent agent-scoped run leaks in as the baseline/history
// for a team-wide cron or dashboard read and fires false regression alerts.
// Exported for the cross-scope leak test (ELEAA-815, P1-6).
export function teamScope(teamId: string, agentId?: string) {
  return agentId
    ? and(
        eq(reliabilitySnapshots.teamId, teamId),
        eq(reliabilitySnapshots.agentId, agentId),
      )
    : and(
        eq(reliabilitySnapshots.teamId, teamId),
        isNull(reliabilitySnapshots.agentId),
      );
}

// Run the attack pack for a team, persist the snapshot, detect regression vs the
// team's previous snapshot, and page any opted-in alert config on a regression.
// Never throws on the notify path — a failed page must not lose the snapshot.
export async function recordSnapshot(
  teamId: string,
  opts: RecordSnapshotOpts = {},
): Promise<RecordSnapshotResult> {
  const rules = opts.rules ?? DEFAULT_RULES;
  const pack = opts.pack ?? ATTACK_PACK;
  const source = opts.source ?? "cron";
  const db = getDb();

  const report = runReliabilityCheck(rules, pack);
  const byCategory = reportToCategories(report);

  // Load the team's previous snapshot (same agent scope) to compare against.
  const prevRows = (await db
    .select()
    .from(reliabilitySnapshots)
    .where(teamScope(teamId, opts.agentId))
    .orderBy(desc(reliabilitySnapshots.createdAt))
    .limit(1)) as SnapshotRow[];
  const prev = prevRows[0] ?? null;

  const regression = detectRegression(
    prev ? { score: prev.score, grade: prev.grade, byCategory: prev.byCategory } : null,
    { score: report.score, grade: report.grade, byCategory },
  );

  const inserted = (await db
    .insert(reliabilitySnapshots)
    .values({
      teamId,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      score: report.score,
      grade: report.grade,
      attacksTotal: report.attacksTotal,
      attacksCaught: report.attacksCaught,
      controlsTotal: report.controlsTotal,
      falsePositives: report.falsePositives,
      unprotectedExposure: unprotectedExposure(pack),
      byCategory,
      source,
      regression: regression.isRegression,
      ...(regression.reason ? { regressionReason: regression.reason } : {}),
    })
    .returning()) as SnapshotRow[];

  const snapshot = inserted[0]!;

  let notified = 0;
  if (regression.isRegression) {
    notified = await notifyRegression(teamId, snapshot, regression);
  }

  return { snapshot, regression, notified };
}

// Page every active alert config for the team that opted into regression alerts.
// Returns the number of successful sends. Never throws.
async function notifyRegression(
  teamId: string,
  snapshot: SnapshotRow,
  regression: RegressionResult,
): Promise<number> {
  try {
    const db = getDb();
    const configs = await db
      .select()
      .from(alertConfigs)
      .where(eq(alertConfigs.teamId, teamId));
    const targets = configs.filter(
      (cfg) =>
        cfg.active &&
        (cfg.enabledEvents as string[]).includes(RELIABILITY_REGRESSION_EVENT),
    );
    if (targets.length === 0) return 0;

    const msg = {
      event: RELIABILITY_REGRESSION_EVENT,
      title: `📉 Reliability posture regressed — grade ${snapshot.grade}`,
      summary:
        `Scheduled Reliability Check for team \`${teamId}\` regressed: ${regression.reason}.`,
      fields: [
        { label: "Grade", value: snapshot.grade },
        { label: "Score", value: `${snapshot.score}/100 (Δ ${regression.scoreDelta})` },
        {
          label: "Coverage",
          value: `${snapshot.attacksCaught}/${snapshot.attacksTotal} attacks caught`,
        },
        ...(regression.newlyLandingCategories.length
          ? [{ label: "New attacks landing", value: regression.newlyLandingCategories.join(", ") }]
          : []),
      ],
      actionUrl: `${DASHBOARD_URL}/reliability`,
      actionLabel: "View trend",
    };

    const results = await Promise.allSettled(
      targets.map((cfg) =>
        sendNotification(cfg.webhookUrl!, cfg.channel as NotifyChannel, msg),
      ),
    );
    return results.filter((r) => r.status === "fulfilled").length;
  } catch (err) {
    console.error("[reliability] notifyRegression error:", err);
    return 0;
  }
}

export interface ListSnapshotsOpts {
  agentId?: string | undefined;
  limit?: number | undefined;
}

// Chronological (oldest → newest) history for the dashboard score-over-time
// chart. Bounded; newest rows win when the cap is hit.
export async function listSnapshots(
  teamId: string,
  opts: ListSnapshotsOpts = {},
): Promise<SnapshotRow[]> {
  const limit = Math.min(opts.limit ?? 90, 365);
  const db = getDb();
  const rows = (await db
    .select()
    .from(reliabilitySnapshots)
    .where(teamScope(teamId, opts.agentId))
    .orderBy(desc(reliabilitySnapshots.createdAt))
    .limit(limit)) as SnapshotRow[];
  // Return oldest-first for a left-to-right time axis.
  return rows.reverse();
}

// Distinct teams to run the scheduled check for: those that have configured any
// alert destination (i.e. teams that opted into monitoring). Bounds the cron's
// work to teams that care while the attack pack runs in-process and is cheap.
export async function teamsToScan(): Promise<string[]> {
  const db = getDb();
  const rows = (await db
    .select({ teamId: alertConfigs.teamId })
    .from(alertConfigs)) as Array<{ teamId: string }>;
  return [...new Set(rows.map((r) => r.teamId))];
}
