import type { Db } from "../db/client.js";
import { alertConfigs } from "../db/schema.js";
import { and, eq } from "drizzle-orm";

export interface RunawayAlertData {
  agentId: string;
  reason: "velocity" | "loop" | "manual";
  tokenCount: number;
  estimatedCostUsd: number;
  actionTaken: string;
  cooldownUntil?: string;
}

export async function fireRunawayAlert(
  db: Db,
  teamId: string,
  data: RunawayAlertData
): Promise<void> {
  const configs = await db
    .select()
    .from(alertConfigs)
    .where(
      and(
        eq(alertConfigs.teamId, teamId),
        eq(alertConfigs.alertType, "runaway_detected")
      )
    );

  if (configs.length === 0) return;

  const payload = {
    alertType: "runaway_detected",
    teamId,
    timestamp: new Date().toISOString(),
    ...data,
  };

  await Promise.allSettled(
    configs.map((cfg) => dispatch(cfg.channel, cfg.destination, payload))
  );
}

async function dispatch(
  channel: string,
  destination: string,
  payload: unknown
): Promise<void> {
  try {
    const res = await fetch(destination, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[alert] ${channel} dispatch failed: ${res.status} ${destination}`);
    }
  } catch (err) {
    console.error(`[alert] ${channel} dispatch error:`, err);
  }
}
