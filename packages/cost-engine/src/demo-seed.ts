import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, and, inArray } from "drizzle-orm";
import {
  teams,
  users,
  agents,
  apiKeys,
  budgets,
  runawayEvents,
  alertConfigs,
  costEvents,
} from "@steadio/shared/schema";
import type { Database } from "./db.js";

export const DEMO_TEAM_SLUG = "steadio-demo";
export const DEMO_USER_EMAIL = "demo@steadio.ai";
export const DEMO_USER_PASSWORD = "demo1234";
export const DEMO_USER_NAME = "Demo User";

interface DemoIds {
  teamId: string;
  userId: string;
  agentIds: Record<string, string>;
}

const DEMO_AGENTS = [
  {
    key: "content-generator",
    name: "content-generator",
    externalId: "agent-content-gen-001",
    provider: "openai",
    model: "gpt-4o",
  },
  {
    key: "customer-support",
    name: "customer-support",
    externalId: "agent-support-001",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  },
  {
    key: "data-analyst",
    name: "data-analyst",
    externalId: "agent-analyst-001",
    provider: "google",
    model: "gemini-1.5-pro",
  },
  {
    key: "code-reviewer",
    name: "code-reviewer",
    externalId: "agent-codereview-001",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  },
  {
    key: "report-builder",
    name: "report-builder",
    externalId: "agent-reports-001",
    provider: "openai",
    model: "gpt-4-turbo",
  },
] as const;

// Pricing in cents per 1M tokens (matching pricing.ts)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 250, output: 1000 },
  "gpt-4-turbo": { input: 1000, output: 3000 },
  "claude-sonnet-4-6": { input: 300, output: 1500 },
  "claude-haiku-4-5-20251001": { input: 80, output: 400 },
  "gemini-1.5-pro": { input: 125, output: 500 },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  return Math.ceil((inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output);
}

// Gaussian-ish random using Box-Muller
function gaussRand(mean: number, stddev: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + stddev * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export async function seedDemoData(db: Database): Promise<DemoIds> {
  // Upsert demo team
  const existingTeams = await db
    .select()
    .from(teams)
    .where(eq(teams.slug, DEMO_TEAM_SLUG))
    .limit(1);

  let teamId: string;
  if (existingTeams[0]) {
    teamId = existingTeams[0].id;
  } else {
    const inserted = await db
      .insert(teams)
      .values({ name: "Acme AI Platform", slug: DEMO_TEAM_SLUG })
      .returning({ id: teams.id });
    teamId = inserted[0]!.id;
  }

  // Upsert demo user
  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, DEMO_USER_EMAIL))
    .limit(1);

  let userId: string;
  if (existingUsers[0]) {
    userId = existingUsers[0].id;
    // Update teamId in case it changed
    await db.update(users).set({ teamId }).where(eq(users.id, userId));
  } else {
    const passwordHash = await bcrypt.hash(DEMO_USER_PASSWORD, 10);
    const inserted = await db
      .insert(users)
      .values({
        email: DEMO_USER_EMAIL,
        name: DEMO_USER_NAME,
        passwordHash,
        role: "admin",
        teamId,
      })
      .returning({ id: users.id });
    userId = inserted[0]!.id;
  }

  // Upsert demo API key (for display purposes)
  const existingKeys = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.name, "Production")))
    .limit(1);

  if (!existingKeys[0]) {
    const rawKey = `elev_demo_${randomBytes(16).toString("hex")}`;
    const keyHash = createHash("sha256").update(rawKey).digest("hex");
    await db.insert(apiKeys).values({
      teamId,
      keyHash,
      keyPrefix: rawKey.slice(0, 12),
      name: "Production",
    });
  }

  // Upsert agents
  const agentIds: Record<string, string> = {};
  for (const agentDef of DEMO_AGENTS) {
    const existing = await db
      .select()
      .from(agents)
      .where(and(eq(agents.teamId, teamId), eq(agents.name, agentDef.name)))
      .limit(1);

    if (existing[0]) {
      agentIds[agentDef.key] = existing[0].id;
    } else {
      const inserted = await db
        .insert(agents)
        .values({
          teamId,
          name: agentDef.name,
          externalId: agentDef.externalId,
          provider: agentDef.provider,
          model: agentDef.model,
        })
        .returning({ id: agents.id });
      agentIds[agentDef.key] = inserted[0]!.id;
    }
  }

  // Generate 30 days of cost events
  await generateCostEvents(db, teamId, agentIds);

  // Upsert budgets
  await upsertBudgets(db, teamId, agentIds);

  // Upsert runaway events
  await upsertRunawayEvents(db, teamId, agentIds);

  // Upsert alert configs
  await upsertAlertConfigs(db, teamId);

  return { teamId, userId, agentIds };
}

async function generateCostEvents(
  db: Database,
  teamId: string,
  agentIds: Record<string, string>,
): Promise<void> {
  // Delete existing demo cost events for this team so reset is clean
  await db.delete(costEvents).where(eq(costEvents.teamId, teamId));

  const now = new Date();
  const rows: (typeof costEvents.$inferInsert)[] = [];

  // Agent traffic profiles: [requests/day weekday, requests/day weekend, avg input tokens, avg output tokens, workflow prefix]
  const profiles: Record<
    string,
    {
      weekdayRPD: number;
      weekendRPD: number;
      avgInput: number;
      avgOutput: number;
      model: string;
      provider: string;
      workflow?: string;
    }
  > = {
    "content-generator": {
      weekdayRPD: 120,
      weekendRPD: 30,
      avgInput: 800,
      avgOutput: 1200,
      model: "gpt-4o",
      provider: "openai",
      workflow: "content-pipeline",
    },
    "customer-support": {
      weekdayRPD: 200,
      weekendRPD: 60,
      avgInput: 400,
      avgOutput: 500,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      workflow: "support-workflow",
    },
    "data-analyst": {
      weekdayRPD: 80,
      weekendRPD: 10,
      avgInput: 2000,
      avgOutput: 800,
      model: "gemini-1.5-pro",
      provider: "google",
      workflow: "analytics-job",
    },
    "code-reviewer": {
      weekdayRPD: 300,
      weekendRPD: 50,
      avgInput: 600,
      avgOutput: 300,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    },
    "report-builder": {
      weekdayRPD: 15,
      weekendRPD: 2,
      avgInput: 3000,
      avgOutput: 2000,
      model: "gpt-4-turbo",
      provider: "openai",
      workflow: "report-gen",
    },
  };

  for (let dayOffset = 30; dayOffset >= 0; dayOffset--) {
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - dayOffset);
    const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;

    for (const [agentKey, profile] of Object.entries(profiles)) {
      const agentId = agentIds[agentKey];
      if (!agentId) continue;

      const baseRPD = isWeekend ? profile.weekendRPD : profile.weekdayRPD;
      // Add a spike on day 22 ago for content-generator (anomaly to demo)
      const spikeMultiplier =
        agentKey === "content-generator" && dayOffset === 22 ? 4 : 1;
      const reqCount = Math.max(1, Math.round(gaussRand(baseRPD * spikeMultiplier, baseRPD * 0.2)));

      // Distribute requests throughout the day with business-hours bias
      for (let r = 0; r < reqCount; r++) {
        // Business hours: most traffic between 8am-6pm local
        let hour: number;
        if (Math.random() < 0.75) {
          hour = 8 + Math.floor(Math.random() * 10); // 8-18
        } else {
          hour = Math.floor(Math.random() * 24);
        }
        const minute = Math.floor(Math.random() * 60);
        const second = Math.floor(Math.random() * 60);

        const ts = new Date(dayDate);
        ts.setHours(hour, minute, second, 0);

        const inputTokens = Math.max(50, Math.round(gaussRand(profile.avgInput, profile.avgInput * 0.3)));
        const outputTokens = Math.max(20, Math.round(gaussRand(profile.avgOutput, profile.avgOutput * 0.3)));
        const costCents = calcCost(profile.model, inputTokens, outputTokens);
        const durationMs = Math.max(100, Math.round(gaussRand(1500, 600)));

        const workflowId =
          profile.workflow && Math.random() < 0.85
            ? `${profile.workflow}-${Math.floor(r / 5)}`
            : undefined;

        rows.push({
          agentId,
          teamId,
          requestId: `req-${randomBytes(8).toString("hex")}`,
          workflowId: workflowId ?? null,
          provider: profile.provider,
          model: profile.model,
          inputTokens,
          outputTokens,
          costCents,
          durationMs,
          createdAt: ts,
        });
      }
    }
  }

  // Batch insert in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(costEvents).values(rows.slice(i, i + 500));
  }
}

async function upsertBudgets(
  db: Database,
  teamId: string,
  agentIds: Record<string, string>,
): Promise<void> {
  // Clean existing demo budgets
  await db.delete(budgets).where(eq(budgets.teamId, teamId));

  await db.insert(budgets).values([
    {
      teamId,
      agentId: null,
      name: "Monthly Team Budget",
      periodType: "monthly",
      limitCents: 50000, // $500/month
      alertThresholdPercent: 80,
      enforcementMode: "alert",
      hardLimit: false,
    },
    {
      teamId,
      agentId: agentIds["content-generator"] ?? null,
      name: "Content Generator Daily Cap",
      periodType: "daily",
      limitCents: 2000, // $20/day
      alertThresholdPercent: 75,
      enforcementMode: "kill",
      hardLimit: true,
    },
    {
      teamId,
      agentId: agentIds["customer-support"] ?? null,
      name: "Support Agent Rolling Budget",
      periodType: "rolling_30d",
      limitCents: 15000, // $150/month
      alertThresholdPercent: 85,
      enforcementMode: "throttle",
      hardLimit: false,
    },
  ]);
}

async function upsertRunawayEvents(
  db: Database,
  teamId: string,
  agentIds: Record<string, string>,
): Promise<void> {
  await db.delete(runawayEvents).where(eq(runawayEvents.teamId, teamId));

  const contentAgentId = agentIds["content-generator"] ?? "";
  const codeAgentId = agentIds["code-reviewer"] ?? "";

  const eightDaysAgo = new Date();
  eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  await db.insert(runawayEvents).values([
    {
      agentId: contentAgentId,
      teamId,
      triggerType: "velocity",
      tokenCount: 2400000,
      estimatedCostCents: 8400,
      evidence: {
        windowSeconds: 300,
        requestCount: 47,
        tokensPerSecond: 8000,
        threshold: 5000,
      },
      actionTaken: "circuit_break",
      overriddenAt: new Date(eightDaysAgo.getTime() + 3600000),
      overrideReason: "Batch content generation job — approved spike",
      cooldownUntil: null,
      createdAt: eightDaysAgo,
    },
    {
      agentId: codeAgentId,
      teamId,
      triggerType: "loop",
      tokenCount: 180000,
      estimatedCostCents: 720,
      evidence: {
        windowSeconds: 60,
        repetitionScore: 0.92,
        sampleRequestIds: ["req-aabbcc", "req-ddeeff", "req-112233"],
      },
      actionTaken: "circuit_break",
      createdAt: twoDaysAgo,
    },
  ]);
}

async function upsertAlertConfigs(db: Database, teamId: string): Promise<void> {
  await db.delete(alertConfigs).where(eq(alertConfigs.teamId, teamId));

  await db.insert(alertConfigs).values([
    {
      teamId,
      name: "Slack — Engineering Alerts",
      channel: "slack",
      webhookUrl: "https://hooks.slack.com/services/DEMO/DEMO/DEMO",
      enabledEvents: [
        "budget.alert_threshold",
        "budget.hard_limit",
        "runaway.detected",
        "runaway.circuit_break",
      ],
      active: true,
    },
    {
      teamId,
      name: "PagerDuty — Critical Spend",
      channel: "webhook",
      webhookUrl: "https://events.pagerduty.com/v2/enqueue/DEMO",
      enabledEvents: ["budget.hard_limit", "runaway.circuit_break"],
      active: true,
    },
  ]);
}

export async function clearDemoData(db: Database): Promise<void> {
  const teamRows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.slug, DEMO_TEAM_SLUG))
    .limit(1);

  if (!teamRows[0]) return;
  const teamId = teamRows[0].id;

  // Delete all data associated with the demo team
  await db.delete(costEvents).where(eq(costEvents.teamId, teamId));
  await db.delete(runawayEvents).where(eq(runawayEvents.teamId, teamId));
  await db.delete(budgets).where(eq(budgets.teamId, teamId));
  await db.delete(alertConfigs).where(eq(alertConfigs.teamId, teamId));

  // Get agent IDs for this team and delete them
  const agentRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.teamId, teamId));
  if (agentRows.length > 0) {
    await db
      .delete(agents)
      .where(inArray(agents.id, agentRows.map((a) => a.id)));
  }

  // Delete API keys and user
  await db.delete(apiKeys).where(eq(apiKeys.teamId, teamId));
  await db.delete(users).where(eq(users.email, DEMO_USER_EMAIL));
}
