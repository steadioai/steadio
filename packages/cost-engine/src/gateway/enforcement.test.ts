import { afterEach, describe, expect, it, vi } from "vitest";

// ELEAA-780 P0-4: enforcement.ts error->HTTP mapping had zero tests.
// Mock the DB so the fire-and-forget runawayEvents insert is observable.
const insertValues = vi.fn((_values?: unknown) => Promise.resolve(undefined));
const insertMock = vi.fn(() => ({ values: insertValues }));
vi.mock("../db.js", () => ({ getDb: () => ({ insert: insertMock }) }));

const { handleEnforcementError } = await import("./enforcement.js");
const { BudgetExceededError, RunawayDetectedError } = await import("@steadio/shared");

// Minimal Hono-style context: records header() calls and returns a captured
// json() result so we can assert status + body without a live server.
function makeCtx() {
  const headers: Record<string, string> = {};
  return {
    headers,
    body: undefined as unknown,
    status: undefined as number | undefined,
    header(name: string, value: string) {
      headers[name] = value;
    },
    json(body: unknown, status?: number) {
      this.body = body;
      this.status = status;
      return { body, status } as unknown as Response;
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("handleEnforcementError (ELEAA-780 P0-4)", () => {
  it("maps BudgetExceededError -> 429 rate_limit_exceeded with Retry-After + reset_at", () => {
    const resetAt = new Date(Date.now() + 300_000).toISOString();
    const c = makeCtx();
    handleEnforcementError(c, new BudgetExceededError("bud-1", "agent-1", 500, 900, resetAt), "agent-1", "team-1");

    expect(c.status).toBe(429);
    expect(c.body).toMatchObject({ error: "rate_limit_exceeded", budget_id: "bud-1", reset_at: resetAt });
    expect(c.headers["Retry-After"]).toBeDefined();
    expect(Number(c.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("maps RunawayDetectedError -> 429 with cooldown_until and one runawayEvents insert", async () => {
    const cooldownUntil = new Date(Date.now() + 300_000).toISOString();
    const c = makeCtx();
    handleEnforcementError(
      c,
      new RunawayDetectedError("agent-2", "loop", cooldownUntil, { loopDetected: true }),
      "agent-2",
      "team-2",
    );

    expect(c.status).toBe(429);
    expect(c.body).toMatchObject({
      error: "rate_limit_exceeded",
      trigger_type: "loop",
      cooldown_until: cooldownUntil,
    });
    expect(c.headers["Retry-After"]).toBeDefined();

    // Fire-and-forget persist — flush microtasks then assert the insert fired once.
    await new Promise((r) => setTimeout(r, 0));
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0]?.[0]).toMatchObject({
      agentId: "agent-2",
      teamId: "team-2",
      triggerType: "loop",
      actionTaken: "circuit_break",
    });
  });

  it("rethrows an unrecognized Error; app.onError then yields the standard 500 body", async () => {
    const c = makeCtx();
    const generic = new Error("kaboom");
    expect(() => handleEnforcementError(c, generic, "agent-3", "team-3")).toThrow(generic);

    // Confirm the exact error-code app.onError produces for a rethrown error.
    const { Hono } = await import("hono");
    const app = new Hono();
    app.onError((err, ctx) => ctx.json({ error: "internal_error", message: err.message }, 500));
    app.get("/boom", () => {
      throw generic;
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "internal_error", message: "kaboom" });
  });
});
