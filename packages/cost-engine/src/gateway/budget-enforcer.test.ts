import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { budgets, costEvents, alertConfigs } from "@steadio/shared/schema";

// ELEAA-780 P0-2: budget-enforcer.ts had zero tests. This is money-path code —
// pin each enforcement mode and both fail-open branches (Redis read / Redis write).

const getDbMock = vi.fn();
const getRedisMock = vi.fn();
vi.mock("../db.js", () => ({ getDb: getDbMock }));
vi.mock("../redis.js", () => ({ getRedis: getRedisMock }));

const { checkBudgets, recordSpend } = await import("./budget-enforcer.js");
const { BudgetExceededError } = await import("@steadio/shared");

// db.select(...).from(table).where(...) resolves to the rows registered for that
// table. Every table used by the enforcer routes through one map.
function makeDb(rowsByTable: Map<unknown, unknown[]>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => rowsByTable.get(table) ?? []),
      })),
    })),
  };
}

function baseBudget(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "bud-1",
    teamId: "team-1",
    agentId: null,
    name: "Prod cap",
    periodType: "daily",
    limitCents: 500,
    enforcementMode: "kill",
    alertThresholdPercent: 101, // above 100 so only the exceed path fires (one alert)
    throttleModel: null,
    ...over,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("checkBudgets enforcement modes (ELEAA-780 P0-2)", () => {
  it("kill mode at/over limit throws BudgetExceededError with populated fields", async () => {
    getDbMock.mockReturnValue(makeDb(new Map([[budgets, [baseBudget()]]])));
    // Redis cache hit => spend 900 >= limit 500, no DB spend query needed.
    getRedisMock.mockReturnValue({ get: vi.fn(async () => "900"), set: vi.fn(async () => "OK"), setex: vi.fn(async () => "OK") });

    const err = await checkBudgets("team-1", "agent-1").catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({
      budgetId: "bud-1",
      capAmountCents: 500,
      currentSpendCents: 900,
    });
    expect((err as InstanceType<typeof BudgetExceededError>).resetAt).toBeTruthy();
  });

  it("throttle mode at/over limit returns {throttle,throttleModel} and does not throw", async () => {
    getDbMock.mockReturnValue(
      makeDb(new Map([[budgets, [baseBudget({ enforcementMode: "throttle", throttleModel: "gpt-4o-mini" })]]])),
    );
    getRedisMock.mockReturnValue({ get: vi.fn(async () => "900"), set: vi.fn(async () => "OK"), setex: vi.fn(async () => "OK") });

    await expect(checkBudgets("team-1", "agent-1")).resolves.toMatchObject({
      throttle: true,
      throttleModel: "gpt-4o-mini",
    });
  });

  it("alert mode (non-kill/throttle) at/over limit proceeds and dispatches exactly one alert", async () => {
    getDbMock.mockReturnValue(
      makeDb(
        new Map<unknown, unknown[]>([
          [budgets, [baseBudget({ enforcementMode: "alert" })]],
          [alertConfigs, [{ id: "ac-1", teamId: "team-1", active: true, channel: "webhook", webhookUrl: "https://hooks.example/x", enabledEvents: ["budget_threshold"] }]],
        ]),
      ),
    );
    getRedisMock.mockReturnValue({ get: vi.fn(async () => "500"), set: vi.fn(async () => "OK"), setex: vi.fn(async () => "OK") });

    const res = await checkBudgets("team-1", "agent-1");
    expect(res.throttle).toBe(false);
    // Flush the fire-and-forget dispatch, then assert exactly one webhook POST.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://hooks.example/x");
  });

  it("fail-open read: Redis get throws -> sums costEvents in Postgres, kill still enforces on the DB sum", async () => {
    getDbMock.mockReturnValue(
      makeDb(
        new Map<unknown, unknown[]>([
          [budgets, [baseBudget()]],
          // DB-derived spend = 300 + 400 = 700 >= 500
          [costEvents, [{ costCents: 300 }, { costCents: 400 }]],
        ]),
      ),
    );
    getRedisMock.mockReturnValue({
      get: vi.fn(async () => {
        throw new Error("redis down");
      }),
      set: vi.fn(async () => "OK"),
      setex: vi.fn(async () => "OK"),
    });

    const err = await checkBudgets("team-1", "agent-1").catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ currentSpendCents: 700 });
  });
});

describe("recordSpend fail-open write (ELEAA-780 P0-2)", () => {
  it("swallows a Redis incrby/expire error and returns normally", async () => {
    getDbMock.mockReturnValue(makeDb(new Map([[budgets, [{ id: "bud-1", agentId: null }]]])));
    getRedisMock.mockReturnValue({
      incrby: vi.fn(async () => {
        throw new Error("redis down");
      }),
      expire: vi.fn(async () => 1),
    });

    await expect(recordSpend("team-1", "agent-1", 42)).resolves.toBeUndefined();
  });
});
