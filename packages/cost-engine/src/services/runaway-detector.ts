import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { runaways } from "../db/schema.js";
import { v4 as uuidv4 } from "uuid";

const VELOCITY_WINDOW_SECONDS = 300; // 5-minute rolling window
const VELOCITY_MULTIPLIER = 10; // 10× rolling avg triggers runaway
const VELOCITY_MIN_SAMPLES = 3;
const VELOCITY_MIN_AVG_TOKENS = 100; // ignore negligible-traffic baselines
const LOOP_WINDOW_SECONDS = 60;
const LOOP_CALL_THRESHOLD = 5; // same prompt hash 5× in 60s = loop
const COOLDOWN_SECONDS = 300; // 5-minute circuit break cooldown

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerInfo {
  state: CircuitBreakerState;
  agentId: string;
  reason?: "velocity" | "loop" | "manual";
  detectedAt?: string;
  cooldownUntil?: string;
  estimatedCostUsd?: number;
}

export async function getCircuitBreakerState(
  redis: Redis,
  agentId: string
): Promise<CircuitBreakerInfo> {
  const key = `runaway:circuit:${agentId}`;
  const val = await redis.get(key);
  if (!val) return { state: "closed", agentId };
  const data = JSON.parse(val) as Omit<CircuitBreakerInfo, "agentId">;
  return { ...data, agentId };
}

/**
 * Track token velocity in a sliding window. Detects a 10× spike vs rolling average.
 * Returns { runaway: true, reason: "velocity" } when triggered.
 */
export async function trackVelocityAndDetectRunaway(
  redis: Redis,
  agentId: string,
  tokens: number
): Promise<{ runaway: boolean; reason?: "velocity" }> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `runaway:tokens:${agentId}`;

  // Sorted set: score = unix timestamp, member = "timestamp:tokens"
  await redis.zadd(windowKey, now, `${now}:${tokens}`);
  await redis.zremrangebyscore(windowKey, 0, now - VELOCITY_WINDOW_SECONDS);
  await redis.expire(windowKey, VELOCITY_WINDOW_SECONDS * 2);

  const entries = await redis.zrange(windowKey, 0, -1);
  if (entries.length < VELOCITY_MIN_SAMPLES) return { runaway: false };

  const tokenCounts = entries.map((e) => {
    const colonIdx = e.indexOf(":");
    return Number(e.slice(colonIdx + 1));
  });

  const latest = tokenCounts[tokenCounts.length - 1] ?? 0;
  // Compute baseline average EXCLUDING the current sample to prevent the spike
  // from inflating the average it's being compared against.
  const baseline = tokenCounts.slice(0, -1);
  const total = baseline.reduce((a, b) => a + b, 0);
  const avg = total / baseline.length;

  if (avg > VELOCITY_MIN_AVG_TOKENS && latest > avg * VELOCITY_MULTIPLIER) {
    return { runaway: true, reason: "velocity" };
  }

  return { runaway: false };
}

/**
 * Track prompt hash occurrences. Detects when the same hash appears ≥ LOOP_CALL_THRESHOLD
 * times in LOOP_WINDOW_SECONDS, indicating an infinite loop.
 */
export async function trackLoopSignature(
  redis: Redis,
  agentId: string,
  promptHash: string
): Promise<{ loop: boolean; count: number }> {
  const key = `runaway:loop:${agentId}:${promptHash}`;
  const count = await redis.incr(key);
  if (count === 1) {
    // First occurrence: set TTL for the window
    await redis.expire(key, LOOP_WINDOW_SECONDS);
  }
  return { loop: count >= LOOP_CALL_THRESHOLD, count };
}

/**
 * Open the circuit breaker for an agent, persisting the event to the DB.
 */
export async function circuitBreakAgent(
  redis: Redis,
  db: Db,
  agentId: string,
  teamId: string,
  reason: "velocity" | "loop" | "manual",
  tokenCount: number,
  estimatedCostUsd: number
): Promise<void> {
  const key = `runaway:circuit:${agentId}`;
  const now = new Date();
  const cooldownUntil = new Date(now.getTime() + COOLDOWN_SECONDS * 1000);

  const info: Omit<CircuitBreakerInfo, "agentId"> = {
    state: "open",
    reason,
    detectedAt: now.toISOString(),
    cooldownUntil: cooldownUntil.toISOString(),
    estimatedCostUsd,
  };

  await redis.set(key, JSON.stringify(info), "EX", COOLDOWN_SECONDS);

  // Persist runaway event to DB for audit trail
  await db.insert(runaways).values({
    id: uuidv4(),
    agentId,
    teamId,
    triggerType: reason,
    tokenCount,
    estimatedCostUsd: estimatedCostUsd.toFixed(8),
    actionTaken: "circuit_break",
    cooldownUntil,
  });
}

/**
 * Manually trip the circuit breaker (opens it without a detection event).
 */
export async function tripCircuitBreaker(
  redis: Redis,
  db: Db,
  agentId: string,
  teamId: string
): Promise<void> {
  await circuitBreakAgent(redis, db, agentId, teamId, "manual", 0, 0);
}

/**
 * Reset a circuit breaker.
 * halfOpen=true → transition to half-open (allows one test request through).
 * halfOpen=false → close fully (delete Redis key).
 */
export async function resetCircuitBreaker(
  redis: Redis,
  agentId: string,
  halfOpen = false
): Promise<void> {
  const key = `runaway:circuit:${agentId}`;
  if (halfOpen) {
    const info: Omit<CircuitBreakerInfo, "agentId"> = {
      state: "half-open",
      detectedAt: new Date().toISOString(),
    };
    // Half-open lasts twice as long as the normal cooldown
    await redis.set(key, JSON.stringify(info), "EX", COOLDOWN_SECONDS * 2);
  } else {
    await redis.del(key);
  }
}

export { COOLDOWN_SECONDS };
