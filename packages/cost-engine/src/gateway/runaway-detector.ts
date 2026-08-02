import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import { RunawayDetectedError } from "@steadio/shared";

const VELOCITY_WINDOW_SECONDS = 300; // 5 minute rolling window
const VELOCITY_MULTIPLIER = 10; // 10x average triggers detection
const HALFOPEN_VELOCITY_MULTIPLIER = 3; // tighter threshold during half-open probe
const LOOP_WINDOW_SECONDS = 60; // 60s window for loop detection
const LOOP_MAX_CALLS = 20; // >20 calls in window
const LOOP_SIMILARITY_THRESHOLD = 0.9; // 90% similar prompts
const COOLDOWN_SECONDS = 300; // 5 minute circuit break
const HALFOPEN_PROBE_SECONDS = 60; // 60s half-open probe window after cooldown

export type CircuitState = "closed" | "open" | "half-open";

interface VelocityCheck {
  currentWindowTokens: number;
  baselineTokensPerWindow: number;
  isRunaway: boolean;
}

export class RunawayDetector {
  constructor(private readonly redis: Redis) {}

  async getCircuitState(agentId: string): Promise<CircuitState> {
    const cooldownTtl = await this.redis.ttl(`runaway:cooldown:${agentId}`);
    if (cooldownTtl > 0) return "open";
    const halfOpenTtl = await this.redis.ttl(`runaway:halfopen:${agentId}`);
    if (halfOpenTtl > 0) return "half-open";
    return "closed";
  }

  // Check if agent is in cooldown (circuit broken)
  async isCircuitBroken(agentId: string): Promise<boolean> {
    return (await this.getCircuitState(agentId)) === "open";
  }

  // Record token usage and check for velocity runaway
  async checkVelocity(
    agentId: string,
    tokens: number,
    halfOpen = false,
  ): Promise<VelocityCheck> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - VELOCITY_WINDOW_SECONDS;

    const velocityKey = `runaway:velocity:${agentId}`;

    await this.redis.zadd(velocityKey, now, `${now}:${tokens}`);
    await this.redis.zremrangebyscore(velocityKey, "-inf", windowStart);
    await this.redis.expire(velocityKey, VELOCITY_WINDOW_SECONDS * 2);

    const members = await this.redis.zrangebyscore(
      velocityKey,
      windowStart,
      "+inf",
    );
    const currentWindowTokens = members.reduce((sum, m) => {
      const parts = m.split(":");
      return sum + parseInt(parts[1] ?? "0", 10);
    }, 0);

    const historicalKey = `runaway:baseline:${agentId}`;
    const baselineStr = await this.redis.get(historicalKey);
    let baselineTokensPerWindow = baselineStr ? parseInt(baselineStr, 10) : 0;

    if (!baselineStr || currentWindowTokens < baselineTokensPerWindow) {
      const newBaseline = baselineTokensPerWindow === 0
        ? currentWindowTokens
        : Math.floor((baselineTokensPerWindow + currentWindowTokens) / 2);
      await this.redis.setex(
        historicalKey,
        VELOCITY_WINDOW_SECONDS * 10,
        newBaseline.toString(),
      );
      baselineTokensPerWindow = newBaseline;
    }

    const multiplier = halfOpen ? HALFOPEN_VELOCITY_MULTIPLIER : VELOCITY_MULTIPLIER;
    const isRunaway =
      baselineTokensPerWindow > 0 &&
      currentWindowTokens > baselineTokensPerWindow * multiplier;

    return { currentWindowTokens, baselineTokensPerWindow, isRunaway };
  }

  // Check for loop detection (repeated similar prompts)
  async checkLoop(agentId: string, promptHash: string): Promise<boolean> {
    const loopKey = `runaway:loop:${agentId}`;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - LOOP_WINDOW_SECONDS;

    const nonce = randomBytes(4).toString("hex");
    await this.redis.zadd(loopKey, now, `${now}:${promptHash}:${nonce}`);
    await this.redis.zremrangebyscore(loopKey, "-inf", windowStart);
    await this.redis.expire(loopKey, LOOP_WINDOW_SECONDS * 2);

    const recentCalls = await this.redis.zrangebyscore(
      loopKey,
      windowStart,
      "+inf",
    );

    if (recentCalls.length <= LOOP_MAX_CALLS) return false;

    const hashes = recentCalls.map((m) => m.split(":")[1] ?? "");
    const hashCounts = hashes.reduce<Record<string, number>>((acc, h) => {
      acc[h] = (acc[h] ?? 0) + 1;
      return acc;
    }, {});

    const maxCount = Math.max(...Object.values(hashCounts));
    const similarityRatio = maxCount / recentCalls.length;

    return similarityRatio >= LOOP_SIMILARITY_THRESHOLD;
  }

  // Trip the circuit breaker for an agent — returns cooldown expiry
  async tripCircuitBreaker(agentId: string): Promise<Date> {
    const cooldownUntil = new Date(Date.now() + COOLDOWN_SECONDS * 1000);
    await this.redis.setex(`runaway:cooldown:${agentId}`, COOLDOWN_SECONDS, "1");
    // Set half-open probe key to expire AFTER cooldown — when cooldown expires,
    // half-open probe becomes visible and allows one test window.
    await this.redis.setex(
      `runaway:halfopen:${agentId}`,
      COOLDOWN_SECONDS + HALFOPEN_PROBE_SECONDS,
      "1",
    );
    return cooldownUntil;
  }

  // Override/reset circuit breaker (manual or admin action)
  async resetCircuitBreaker(agentId: string): Promise<void> {
    await this.redis.del(
      `runaway:cooldown:${agentId}`,
      `runaway:halfopen:${agentId}`,
      `runaway:velocity:${agentId}`,
      `runaway:loop:${agentId}`,
      `runaway:baseline:${agentId}`,
    );
  }

  // Hash a prompt for loop detection (first 500 chars for efficiency)
  static hashPrompt(prompt: string): string {
    return createHash("sha256")
      .update(prompt.slice(0, 500))
      .digest("hex")
      .slice(0, 16);
  }

  // Full runaway check — call on every proxied request
  async check(agentId: string, tokens: number, promptSample: string): Promise<void> {
    const state = await this.getCircuitState(agentId);

    if (state === "open") {
      const ttl = await this.redis.ttl(`runaway:cooldown:${agentId}`);
      const cooldownUntil = new Date(Date.now() + ttl * 1000).toISOString();
      throw new RunawayDetectedError(agentId, "velocity", cooldownUntil, {
        circuitState: "open",
        cooldownTtlSeconds: ttl,
      });
    }

    const isHalfOpen = state === "half-open";
    const promptHash = RunawayDetector.hashPrompt(promptSample);

    const [velocity, isLoop] = await Promise.all([
      this.checkVelocity(agentId, tokens, isHalfOpen),
      this.checkLoop(agentId, promptHash),
    ]);

    if (velocity.isRunaway || isLoop) {
      const cooldownUntil = await this.tripCircuitBreaker(agentId);
      const evidence: Record<string, unknown> = {
        circuitState: isHalfOpen ? "half-open" : "closed",
        promptHash,
        velocityWindowTokens: velocity.currentWindowTokens,
        velocityBaseline: velocity.baselineTokensPerWindow,
        loopDetected: isLoop,
      };
      throw new RunawayDetectedError(
        agentId,
        isLoop ? "loop" : "velocity",
        cooldownUntil.toISOString(),
        evidence,
      );
    }
  }
}
