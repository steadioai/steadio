import { describe, it, expect } from "vitest";
import { getPeriodWindow, budgetRedisKey } from "../services/budget-enforcer.js";

describe("getPeriodWindow", () => {
  it("returns start of today and tomorrow for daily", () => {
    const { start, end } = getPeriodWindow("daily");
    expect(start.getUTCHours()).toBe(0);
    expect(start.getUTCMinutes()).toBe(0);
    const diffMs = end.getTime() - start.getTime();
    expect(diffMs).toBe(24 * 60 * 60 * 1000);
  });

  it("returns start of week (Sunday) for weekly", () => {
    const { start, end } = getPeriodWindow("weekly");
    expect(start.getUTCDay()).toBe(0); // Sunday
    const diffMs = end.getTime() - start.getTime();
    expect(diffMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("returns start of month for monthly", () => {
    const { start, end } = getPeriodWindow("monthly");
    expect(start.getUTCDate()).toBe(1);
    expect(start.getUTCHours()).toBe(0);
    // end should be start of next month
    const nextMonth = new Date(start);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    expect(end.getTime()).toBe(nextMonth.getTime());
  });
});

describe("budgetRedisKey", () => {
  it("generates a stable key", () => {
    const windowStart = new Date("2026-06-01T00:00:00.000Z");
    const key = budgetRedisKey("agent", "agent-123", "monthly", windowStart);
    expect(key).toBe("budget:spend:agent:agent-123:monthly:2026-06-01T00:00:00.000Z");
  });
});
