import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the hardened db/redis the ported gateway now shares with cost-engine, so
// this test exercises the real mount wiring (public demo vs. auth-gated /v1)
// without a live Postgres/Redis.
const getDbMock = vi.fn();
vi.mock("../db.js", () => ({ getDb: getDbMock }));
vi.mock("../redis.js", () => ({ getRedis: vi.fn(() => ({})) }));

const { gatewayRoutes } = await import("./gateway.js");
const { demoRoutes } = await import("./demo.js");
const { authMiddleware } = await import("./auth.js");

// Assemble /v1 exactly as cost-engine/src/app.ts does: public demo mounted before
// the X-SteadIO-Key auth middleware, real forwarding behind it.
function createGatewayApp() {
  const app = new Hono();
  app.use("/v1/demo/*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));
  app.use("/v1/*", bodyLimit({ maxSize: 10 * 1024 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) }));
  app.route("/v1/demo", demoRoutes);
  app.use("/v1/*", authMiddleware);
  app.route("/v1", gatewayRoutes);
  return app;
}

// db that finds no matching api key -> unknown-key requests resolve to 401.
const emptyKeyDb = () => ({
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })) })),
  insert: vi.fn(() => {
    const p: unknown = Promise.resolve([]);
    (p as Record<string, unknown>)["onConflictDoNothing"] = () => Promise.resolve([]);
    (p as Record<string, unknown>)["returning"] = () => Promise.resolve([]);
    return { values: vi.fn(() => p) };
  }),
});

describe("consolidated /v1 gateway wiring", () => {
  beforeEach(() => {
    getDbMock.mockReturnValue(emptyKeyDb());
  });

  it("rejects an authenticated /v1 call with no SteadIO key (401)", async () => {
    const res = await createGatewayApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "missing_api_key" });
  });

  it("rejects an unknown SteadIO key against the real db lookup (401)", async () => {
    const res = await createGatewayApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-steadio-key": "st_not_a_real_key" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ message: expect.any(String) });
  });

  it("serves the public /v1/demo mock without a key (proves demo mounts before auth)", async () => {
    const res = await createGatewayApp().request("/v1/demo/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
    expect(body["x-steadio-demo"]).toBe(true);
    expect((body["usage"] as Record<string, number>)["total_tokens"]).toBeGreaterThan(0);
  });
});
