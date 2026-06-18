import type { Redis } from "ioredis";
import { createMiddleware } from "hono/factory";
import type { ProxyEnv } from "../env.js";

const BUDGET_EXCEEDED_TTL_SECONDS = 300; // 5 minutes

// Fast Redis-based budget check on the hot path.
// If Redis is unavailable, allow the request and log async (circuit breaker).
export function createBudgetCheckMiddleware(redis: Redis) {
  return createMiddleware<ProxyEnv>(async (c, next) => {
    const agentId: string = c.get("agentId") ?? "untagged";
    const teamId: string = c.get("teamId") ?? "untagged";

    try {
      const [agentKilled, teamKilled, circuitRaw] = await Promise.all([
        redis.get(`budget:killed:agent:${agentId}`),
        redis.get(`budget:killed:team:${teamId}`),
        redis.get(`runaway:circuit:${agentId}`),
      ]);

      if (agentKilled) {
        const parsed = JSON.parse(agentKilled) as {
          capAmountUsd: number;
          currentSpendUsd: number;
          resetAt: string;
        };
        return c.json(
          {
            error: "budget_exceeded",
            agent_id: agentId,
            cap_amount: parsed.capAmountUsd,
            current_spend: parsed.currentSpendUsd,
            reset_at: parsed.resetAt,
          },
          402
        );
      }

      if (teamKilled) {
        const parsed = JSON.parse(teamKilled) as {
          capAmountUsd: number;
          currentSpendUsd: number;
          resetAt: string;
        };
        return c.json(
          {
            error: "budget_exceeded",
            team_id: teamId,
            cap_amount: parsed.capAmountUsd,
            current_spend: parsed.currentSpendUsd,
            reset_at: parsed.resetAt,
          },
          402
        );
      }

      // Circuit breaker — block if open, allow if half-open (recovery test)
      if (circuitRaw) {
        const circuit = JSON.parse(circuitRaw) as {
          state: string;
          reason?: string;
          cooldownUntil?: string;
        };
        if (circuit.state === "open") {
          return c.json(
            {
              error: "circuit_open",
              agent_id: agentId,
              reason: circuit.reason ?? "runaway_detected",
              retry_after: circuit.cooldownUntil,
            },
            429
          );
        }
      }
    } catch {
      // Redis down — allow request, log async
      console.warn("[budget-check] Redis unavailable, allowing request");
    }

    await next();
  });
}
