import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ELEAA-780 P0-5: authMiddleware failure modes + the KEY_CACHE revoke window.
// auth.test.ts already covers the el_/st_ back-compat happy path; this file
// covers the 401 branches and the documented 60s cache staleness bug.
const getDbMock = vi.fn();
vi.mock("../db.js", () => ({ getDb: getDbMock }));

const { authMiddleware } = await import("./auth.js");

// resolveApiKey issues two `.limit()`d selects (existence, then active-only).
// Feed their results in order so we can model unknown / revoked keys.
function makeDb(resultQueue: unknown[][]) {
  let i = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => resultQueue[i++] ?? []) })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
  };
}

function appWithAuth() {
  const app = new Hono<{ Variables: { teamId: string; apiKeyId: string } }>();
  app.use("/v1/*", authMiddleware);
  app.post("/v1/probe", (c) => c.json({ ok: true, teamId: c.get("teamId") }));
  return app;
}

function probe(key?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-steadio-key"] = key;
  return appWithAuth().request("/v1/probe", { method: "POST", headers, body: "{}" });
}

describe("authMiddleware failure modes (ELEAA-780 P0-5)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no key header -> 401 missing_api_key", async () => {
    getDbMock.mockReturnValue(makeDb([]));
    const res = await probe();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_api_key" });
  });

  it("unknown key hash -> 401 UNAUTHORIZED / Invalid API key", async () => {
    getDbMock.mockReturnValue(makeDb([[]])); // existence lookup returns nothing
    const res = await probe("st_" + "z".repeat(64));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "UNAUTHORIZED", message: "Invalid API key" });
  });

  it("revoked key (exists but no active row) -> 401 UNAUTHORIZED / API key revoked", async () => {
    const row = { id: "k1", teamId: "team-1" };
    getDbMock.mockReturnValue(makeDb([[row], []])); // exists, but active-only select empty
    const res = await probe("st_revoked_" + "y".repeat(54));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "UNAUTHORIZED", message: "API key revoked" });
  });

  it("BUG: a revoked key stays valid for up to 60s via KEY_CACHE", async () => {
    // A unique key so no other test's cache entry interferes.
    const key = "st_cachewindow_" + "c".repeat(50);
    const row = { id: "k-cache", teamId: "team-cache" };

    // 1) First auth succeeds and populates KEY_CACHE.
    getDbMock.mockReturnValue(makeDb([[row], [row]]));
    const first = await probe(key);
    expect(first.status).toBe(200);

    // 2) Key is now revoked in the DB (active-only select would return []).
    getDbMock.mockReturnValue(makeDb([[row], []]));

    // 3) Re-auth within the 60s TTL still returns 200 — cache is not invalidated
    //    on revoke. This documents the current gap; flip to 401 if we add cache
    //    invalidation on revoke.
    const second = await probe(key);
    expect(second.status).toBe(200);
  });
});
