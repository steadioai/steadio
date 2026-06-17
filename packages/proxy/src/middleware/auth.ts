import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

// API key auth middleware — validates X-Elevation-Key header
// The key is looked up in Redis cache, falling back to DB via cost-engine
export const authMiddleware = createMiddleware(
  async (c: Context, next: Next) => {
    const apiKey =
      c.req.header("X-Elevation-Key") ??
      c.req.header("Authorization")?.replace("Bearer ", "");

    if (!apiKey) {
      return c.json({ error: "missing_api_key" }, 401);
    }

    // TODO: validate against Redis/DB — for now accept any non-empty key
    // and extract team from key prefix (format: el_<teamId>_<random>)
    const parts = apiKey.split("_");
    const teamId = parts.length >= 3 ? (parts[1] ?? "untagged") : "untagged";

    c.set("teamId", teamId);
    c.set("apiKey", apiKey);

    await next();
  }
);
