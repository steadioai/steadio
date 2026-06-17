import type { Redis } from "ioredis";

const VELOCITY_WINDOW_SECONDS = 300; // 5-minute rolling window
const VELOCITY_MULTIPLIER = 10; // 10× rolling avg triggers runaway
const LOOP_WINDOW_SECONDS = 60;
const LOOP_CALL_THRESHOLD = 20;
const LOOP_SIMILARITY_THRESHOLD = 0.9;
const COOLDOWN_SECONDS = 300; // 5-minute circuit break

export async function trackVelocityAndDetectRunaway(
  redis: Redis,
  agentId: string,
  tokens: number
): Promise<{ runaway: boolean; reason?: "velocity" | "loop" }> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `runaway:tokens:${agentId}`;

  // Add current token count to sorted set (score = timestamp)
  await redis.zadd(windowKey, now, `${now}:${tokens}`);
  // Remove entries outside the 5-min window
  await redis.zremrangebyscore(windowKey, 0, now - VELOCITY_WINDOW_SECONDS);
  await redis.expire(windowKey, VELOCITY_WINDOW_SECONDS * 2);

  // Get all entries in window
  const entries = await redis.zrange(windowKey, 0, -1);
  if (entries.length < 3) return { runaway: false }; // need at least 3 samples

  const tokenCounts = entries.map((e) => {
    const parts = e.split(":");
    return Number(parts[1] ?? 0);
  });

  const total = tokenCounts.reduce((a, b) => a + b, 0);
  const avg = total / tokenCounts.length;

  // Latest value is 10× the rolling average
  const latest = tokenCounts[tokenCounts.length - 1] ?? 0;
  if (latest > avg * VELOCITY_MULTIPLIER && avg > 100) {
    return { runaway: true, reason: "velocity" };
  }

  return { runaway: false };
}

export async function circuitBreakAgent(
  redis: Redis,
  agentId: string,
  reason: "velocity" | "loop",
  estimatedCostUsd: number
): Promise<void> {
  const key = `runaway:circuit:${agentId}`;
  const cooldownUntil = Math.floor(Date.now() / 1000) + COOLDOWN_SECONDS;

  await redis.set(
    key,
    JSON.stringify({
      reason,
      estimatedCostUsd,
      cooldownUntil,
      detectedAt: new Date().toISOString(),
    }),
    "EX",
    COOLDOWN_SECONDS
  );
}

export async function isAgentCircuitBroken(
  redis: Redis,
  agentId: string
): Promise<boolean> {
  const key = `runaway:circuit:${agentId}`;
  const val = await redis.get(key);
  return val !== null;
}
