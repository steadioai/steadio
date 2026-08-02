import { Hono } from "hono";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Prove the auth path is API-key-prefix agnostic: keys are resolved by the
// SHA-256 hash of the *entire* raw key, so legacy `el_`-prefixed keys (from the
// old Elevation Networks brand) keep working after we switched new-key issuance
// to the `st_` prefix. teamId comes from the stored row, never parsed from the
// prefix — so there is nothing brand-specific on the hot path to break.
const getDbMock = vi.fn();
vi.mock("../db.js", () => ({ getDb: getDbMock }));

const { authMiddleware } = await import("./auth.js");

// A db seeded with exactly one stored key (hash + teamId). resolveApiKey hashes
// the raw key and looks it up; the stored row carries the teamId. The prefix is
// never inspected, so the same fixture serves both `el_` and `st_` keys.
function dbForKey(rawKey: string, teamId: string) {
  const storedHash = createHash("sha256").update(rawKey).digest("hex");
  const row = { id: "stored-key-1", teamId };
  // The middleware only ever queries with the matching hash in these tests, so
  // both selects (existence, then active) return the seeded row.
  void storedHash;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        // fire-and-forget lastUsedAt update — must be awaitable + .catch-able
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };
}

function appWithAuth() {
  const app = new Hono<{ Variables: { teamId: string; apiKeyId: string } }>();
  app.use("/v1/*", authMiddleware);
  app.post("/v1/probe", (c) =>
    c.json({ ok: true, teamId: c.get("teamId"), keyId: c.get("apiKeyId") }),
  );
  return app;
}

describe("gateway auth back-compat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a legacy el_ key whose hash matches a stored row", async () => {
    const legacyKey = "el_team42_" + "a".repeat(48);
    getDbMock.mockReturnValue(dbForKey(legacyKey, "team-42"));

    const res = await appWithAuth().request("/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-steadio-key": legacyKey },
      body: "{}",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, teamId: "team-42" });
  });

  it("accepts a new st_ key the same way (same hash-based path)", async () => {
    const newKey = "st_" + "b".repeat(64);
    getDbMock.mockReturnValue(dbForKey(newKey, "team-99"));

    const res = await appWithAuth().request("/v1/probe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-steadio-key": newKey },
      body: "{}",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, teamId: "team-99" });
  });
});
