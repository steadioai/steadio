import { describe, expect, it, vi } from "vitest";
import { RunawayDetector } from "./runaway-detector.js";
import { RunawayDetectedError } from "@steadio/shared";

// ELEAA-780 P0-3: runaway-detector.ts had zero tests. These drive each trigger
// path against a controllable fake Redis so the money+reliability circuit
// breaker is pinned to exact behavior.

interface RedisOverrides {
  ttl?: (key: string) => number;
  baseline?: string | null;
  velocityMembers?: string[];
  loopMembers?: string[];
}

// A fake ioredis surface. Every method used by RunawayDetector is a vi.fn with a
// benign default; callers override the few that steer a given branch. zrangebyscore
// routes by key so velocity and loop (which both call it in one Promise.all) can
// return independent member lists.
function makeRedis(overrides: RedisOverrides = {}) {
  const velocityMembers: string[] = overrides.velocityMembers ?? [];
  const loopMembers: string[] = overrides.loopMembers ?? [];
  return {
    // ttl(cooldownKey) / ttl(halfopenKey) steer circuit state; default = no key (-2 => closed)
    ttl: vi.fn(async (key: string) => {
      if (typeof overrides.ttl === "function") return overrides.ttl(key);
      return -2;
    }),
    get: vi.fn(async () => overrides.baseline ?? null),
    zadd: vi.fn(async () => 1),
    zremrangebyscore: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    zrangebyscore: vi.fn(async (key: string) =>
      key.includes("velocity") ? velocityMembers : loopMembers,
    ),
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
  };
}

describe("RunawayDetector (ELEAA-780 P0-3)", () => {
  it("throws RunawayDetectedError on a velocity spike (>10x baseline)", async () => {
    // baseline 100, current window 2000 tokens => 2000 > 100*10 => runaway
    const redis = makeRedis({ baseline: "100", velocityMembers: ["1700000000:2000"] });
    const detector = new RunawayDetector(redis as never);

    await expect(detector.check("agent-1", 2000, "prompt")).rejects.toBeInstanceOf(
      RunawayDetectedError,
    );
    await expect(detector.check("agent-1", 2000, "prompt")).rejects.toMatchObject({
      triggerType: "velocity",
    });
  });

  it("throws RunawayDetectedError on a loop (>20 near-identical prompts in 60s)", async () => {
    // 21 members, all the same prompt hash => similarityRatio 1.0 >= 0.9
    const now = 1700000000;
    const loopMembers = Array.from({ length: 21 }, (_, i) => `${now}:samehash:nonce${i}`);
    // Keep velocity quiet: no baseline => isRunaway false regardless of window sum.
    const redis = makeRedis({ loopMembers, baseline: null });
    const detector = new RunawayDetector(redis as never);

    await expect(detector.check("agent-2", 10, "loop prompt")).rejects.toMatchObject({
      triggerType: "loop",
    });
  });

  it("keeps throwing while the circuit is open (inside the 5m cooldown)", async () => {
    // cooldown key alive => getCircuitState returns "open" => short-circuits to throw
    const redis = makeRedis({
      ttl: (key: string) => (key.includes("cooldown") ? 120 : -2),
    });
    const detector = new RunawayDetector(redis as never);

    const err = await detector.check("agent-3", 1, "x").catch((e) => e);
    expect(err).toBeInstanceOf(RunawayDetectedError);
    expect((err as RunawayDetectedError).evidence).toMatchObject({ circuitState: "open" });
    // No velocity/loop evaluation happens when open.
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it("evaluates the half-open probe window against the 3x (not 10x) threshold", async () => {
    // current 400, baseline 100: 400 > 100*3 (half-open) but 400 < 100*10 (closed).
    const halfOpenRedis = makeRedis({
      ttl: (key: string) => (key.includes("halfopen") ? 30 : -2),
      baseline: "100",
      velocityMembers: ["1700000000:400"],
    });
    await expect(
      new RunawayDetector(halfOpenRedis as never).check("agent-4", 400, "x"),
    ).rejects.toMatchObject({ triggerType: "velocity" });

    // Same numbers with the circuit closed must NOT trip (proves the 3x is what caught it).
    const closedRedis = makeRedis({ baseline: "100", velocityMembers: ["1700000000:400"] });
    await expect(
      new RunawayDetector(closedRedis as never).check("agent-4b", 400, "x"),
    ).resolves.toBeUndefined();
  });

  it("KNOWN GAP: a Redis error propagates raw (not caught) and surfaces as a 500 upstream", async () => {
    // Documents current behavior: no local try/catch, so getCircuitState's ttl error
    // bubbles out of check() as a plain Error (handleEnforcementError rethrows it,
    // app.onError maps to 500). If we later decide to fail-open/429, flip this test.
    const boom = new Error("redis down");
    const redis = makeRedis();
    redis.ttl = vi.fn(async () => {
      throw boom;
    });
    const detector = new RunawayDetector(redis as never);

    const err = await detector.check("agent-5", 1, "x").catch((e) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(RunawayDetectedError);
  });
});
