import { describe, it, expect, beforeEach } from "vitest";
import {
  trackVelocityAndDetectRunaway,
  trackLoopSignature,
  getCircuitBreakerState,
  resetCircuitBreaker,
} from "../services/runaway-detector.js";

// In-memory Redis mock — just enough surface for the detector
function makeMockRedis() {
  const store = new Map<string, { value: string; expiresAt: number | undefined }>();
  const sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  const now = () => Math.floor(Date.now() / 1000);

  function isExpired(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    if (entry.expiresAt === undefined) return false;
    return Date.now() > entry.expiresAt;
  }

  return {
    // String ops
    get: async (key: string) => {
      if (isExpired(key)) { store.delete(key); return null; }
      return store.get(key)?.value ?? null;
    },
    set: async (key: string, value: string, exMode?: string, exSeconds?: number) => {
      const expiresAt: number | undefined = exMode === "EX" && exSeconds ? Date.now() + exSeconds * 1000 : undefined;
      store.set(key, { value, expiresAt });
      return "OK";
    },
    del: async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) { if (store.delete(k)) count++; }
      return count;
    },
    // Counter ops
    incr: async (key: string) => {
      const raw = store.get(key)?.value;
      const current = raw ? parseInt(raw, 10) : 0;
      const next = current + 1;
      const existing = store.get(key);
      store.set(key, { value: String(next), expiresAt: existing?.expiresAt });
      return next;
    },
    expire: async (key: string, seconds: number) => {
      const entry = store.get(key);
      if (entry) store.set(key, { ...entry, expiresAt: Date.now() + seconds * 1000 });
      return 1;
    },
    // Sorted set ops
    zadd: async (key: string, score: number, member: string) => {
      if (!sortedSets.has(key)) sortedSets.set(key, []);
      const set = sortedSets.get(key)!;
      set.push({ score, member });
      set.sort((a, b) => a.score - b.score);
      return 1;
    },
    zremrangebyscore: async (key: string, min: number, max: number) => {
      const set = sortedSets.get(key);
      if (!set) return 0;
      const before = set.length;
      const filtered = set.filter((e) => e.score < min || e.score > max);
      sortedSets.set(key, filtered);
      return before - filtered.length;
    },
    zrange: async (key: string, start: number, stop: number) => {
      const set = sortedSets.get(key) ?? [];
      const end = stop === -1 ? set.length : stop + 1;
      return set.slice(start, end).map((e) => e.member);
    },
    _store: store,
    _sortedSets: sortedSets,
  } as unknown as Parameters<typeof trackVelocityAndDetectRunaway>[0];
}

describe("trackVelocityAndDetectRunaway", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns false with fewer than 3 samples", async () => {
    const result = await trackVelocityAndDetectRunaway(redis, "agent-1", 500);
    expect(result.runaway).toBe(false);

    const result2 = await trackVelocityAndDetectRunaway(redis, "agent-1", 500);
    expect(result2.runaway).toBe(false);
  });

  it("does not trigger when tokens are below the avg-floor", async () => {
    // avg too low — avg < 100 threshold
    await trackVelocityAndDetectRunaway(redis, "agent-1", 5);
    await trackVelocityAndDetectRunaway(redis, "agent-1", 5);
    const result = await trackVelocityAndDetectRunaway(redis, "agent-1", 50);
    expect(result.runaway).toBe(false);
  });

  it("detects a 10× spike in token velocity", async () => {
    const agentId = "agent-spike";
    // Establish baseline: 3 calls with ~500 tokens each (avg = 500)
    await trackVelocityAndDetectRunaway(redis, agentId, 500);
    await trackVelocityAndDetectRunaway(redis, agentId, 500);
    await trackVelocityAndDetectRunaway(redis, agentId, 500);
    // 4th call: 10× spike — well above threshold
    const result = await trackVelocityAndDetectRunaway(redis, agentId, 10000);
    expect(result.runaway).toBe(true);
    expect(result.reason).toBe("velocity");
  });

  it("does not false-positive on moderate bursts (< 10×)", async () => {
    const agentId = "agent-burst";
    await trackVelocityAndDetectRunaway(redis, agentId, 1000);
    await trackVelocityAndDetectRunaway(redis, agentId, 1000);
    await trackVelocityAndDetectRunaway(redis, agentId, 1000);
    // 5× spike — should NOT trigger (threshold is 10×)
    const result = await trackVelocityAndDetectRunaway(redis, agentId, 5000);
    expect(result.runaway).toBe(false);
  });
});

describe("trackLoopSignature", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns loop=false below the call threshold", async () => {
    const hash = "abc123";
    const agentId = "agent-loop";

    for (let i = 0; i < 4; i++) {
      const result = await trackLoopSignature(redis, agentId, hash);
      expect(result.loop).toBe(false);
      expect(result.count).toBe(i + 1);
    }
  });

  it("detects a loop at the call threshold (5th identical prompt)", async () => {
    const hash = "deadbeef";
    const agentId = "agent-loopy";

    for (let i = 0; i < 4; i++) {
      await trackLoopSignature(redis, agentId, hash);
    }
    const result = await trackLoopSignature(redis, agentId, hash);
    expect(result.loop).toBe(true);
    expect(result.count).toBe(5);
  });

  it("does not cross-pollute different prompt hashes", async () => {
    const agentId = "agent-multi";
    for (let i = 0; i < 4; i++) {
      await trackLoopSignature(redis, agentId, "hash-a");
    }
    // Different hash — should not be affected
    const result = await trackLoopSignature(redis, agentId, "hash-b");
    expect(result.loop).toBe(false);
    expect(result.count).toBe(1);
  });

  it("does not cross-pollute different agents", async () => {
    for (let i = 0; i < 4; i++) {
      await trackLoopSignature(redis, "agent-x", "same-hash");
    }
    // Different agent — counter starts fresh
    const result = await trackLoopSignature(redis, "agent-y", "same-hash");
    expect(result.loop).toBe(false);
    expect(result.count).toBe(1);
  });
});

describe("getCircuitBreakerState and resetCircuitBreaker", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("returns closed when no key exists", async () => {
    const state = await getCircuitBreakerState(redis, "agent-fresh");
    expect(state.state).toBe("closed");
  });

  it("returns open when key is set", async () => {
    const agentId = "agent-open";
    await redis.set(
      `runaway:circuit:${agentId}`,
      JSON.stringify({ state: "open", reason: "velocity" }),
      "EX",
      300
    );
    const state = await getCircuitBreakerState(redis, agentId);
    expect(state.state).toBe("open");
    expect(state.reason).toBe("velocity");
  });

  it("reset to closed removes the key", async () => {
    const agentId = "agent-reset";
    await redis.set(`runaway:circuit:${agentId}`, JSON.stringify({ state: "open" }), "EX", 300);
    await resetCircuitBreaker(redis, agentId, false);
    const state = await getCircuitBreakerState(redis, agentId);
    expect(state.state).toBe("closed");
  });

  it("reset to half-open sets the half-open state", async () => {
    const agentId = "agent-halfopen";
    await redis.set(`runaway:circuit:${agentId}`, JSON.stringify({ state: "open" }), "EX", 300);
    await resetCircuitBreaker(redis, agentId, true);
    const state = await getCircuitBreakerState(redis, agentId);
    expect(state.state).toBe("half-open");
  });
});
