import type { Context, Next } from "hono";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../config/jwt.js";

const JWT_SECRET = getJwtSecret();

type JwtPayload = {
  sub?: string;
  teamId?: string | null;
  role?: string | undefined;
  capabilities?: string[] | undefined;
};

export type ManagementAuthClaims = {
  userId: string;
  teamId: string;
  role?: string | undefined;
  capabilities: string[];
};

export async function managementAuthMiddleware(c: Context, next: Next) {
  const authorization = c.req.header("authorization");
  const [scheme, bearerToken] = authorization?.split(" ") ?? [];
  const token = scheme?.toLowerCase() === "bearer" ? bearerToken : c.req.query("token");

  if (!token) {
    return c.json(
      { error: "missing_token", message: "Authorization bearer token required" },
      401,
    );
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;

    if (!payload.sub) {
      return c.json({ error: "invalid_token", message: "Invalid authorization token" }, 401);
    }

    if (!payload.teamId) {
      return c.json({ error: "invalid_token", message: "Invalid authorization token" }, 401);
    }

    c.set("userId" as never, payload.sub as never);
    c.set("teamId" as never, payload.teamId as never);
    c.set("role" as never, payload.role as never);
    c.set("capabilities" as never, (Array.isArray(payload.capabilities) ? payload.capabilities : []) as never);

    await next();
  } catch {
    return c.json({ error: "invalid_token", message: "Invalid authorization token" }, 401);
  }
}

export function getManagementAuth(c: Context): ManagementAuthClaims | Response {
  const userId = c.get("userId" as never) as string | undefined;
  const teamId = c.get("teamId" as never) as string | undefined;
  const role = c.get("role" as never) as string | undefined;
  const capabilities = (c.get("capabilities" as never) as string[] | undefined) ?? [];

  if (!userId || !teamId) return c.json({ error: "unauthorized" }, 401);
  return { userId, teamId, role, capabilities };
}

export function requireTeamAccess(c: Context, requestedTeamId: string): ManagementAuthClaims | Response {
  const auth = getManagementAuth(c);
  if (auth instanceof Response) return auth;
  if (auth.teamId !== requestedTeamId) return c.json({ error: "forbidden" }, 403);
  return auth;
}

// Roles allowed to perform team-admin management actions (create/rotate/revoke
// API keys, etc.). "operator" is an elevated Steadio-staff role that is a
// superset of "admin" — it must satisfy every admin gate, otherwise switching a
// user to operator paradoxically strips their team-management access (403).
const TEAM_ADMIN_ROLES = new Set(["admin", "operator"]);

export function isTeamAdminRole(role: string | undefined): boolean {
  return Boolean(role) && TEAM_ADMIN_ROLES.has(role as string);
}

export function requireTeamAdmin(c: Context, requestedTeamId: string): ManagementAuthClaims | Response {
  const auth = requireTeamAccess(c, requestedTeamId);
  if (auth instanceof Response) return auth;
  if (!isTeamAdminRole(auth.role)) return c.json({ error: "forbidden" }, 403);
  return auth;
}

export function hasCapability(auth: ManagementAuthClaims, capability: string): boolean {
  if (isTeamAdminRole(auth.role)) return true;
  return auth.capabilities.includes(capability);
}

export function requireCapability(
  c: Context,
  requestedTeamId: string,
  capability: string,
): ManagementAuthClaims | Response {
  const auth = requireTeamAccess(c, requestedTeamId);
  if (auth instanceof Response) return auth;
  if (!hasCapability(auth, capability)) return c.json({ error: "forbidden" }, 403);
  return auth;
}
