import type { Context, Next } from "hono";

const OPERATOR_ROLES = new Set(["operator"]);

const configuredOperatorTeamIds = () =>
  (process.env["STEADIO_OPERATOR_TEAM_IDS"] ?? process.env["STEADIO_OPERATOR_TEAM_ID"] ?? "")
    .split(",")
    .map((teamId) => teamId.trim())
    .filter(Boolean);

export function isOperator(role: string | undefined, teamId: string | null | undefined): boolean {
  if (role && OPERATOR_ROLES.has(role)) return true;

  const operatorTeamIds = configuredOperatorTeamIds();
  return role === "admin" && Boolean(teamId) && operatorTeamIds.includes(teamId as string);
}

export function isOperatorContext(c: Context): boolean {
  const role = c.get("role" as never) as string | undefined;
  const teamId = c.get("teamId" as never) as string | null | undefined;
  return isOperator(role, teamId);
}

export async function requireOperatorMiddleware(c: Context, next: Next) {
  if (isOperatorContext(c)) {
    await next();
    return;
  }

  return c.json({ error: "forbidden", message: "Operator privileges required" }, 403);
}
