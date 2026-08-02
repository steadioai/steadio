import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@steadio/shared/schema";

export type Database = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  // Supabase's transaction-mode pooler (pgbouncer, host contains "pooler" / port 6543)
  // does not support prepared statements, which postgres-js uses by default. Disable
  // them for pooled connections so the same code works on Vercel serverless (pooled)
  // and Railway (direct). Prepared statements stay on for direct connections.
  const pooled = /pooler|:6543/.test(connectionString);
  const client = postgres(connectionString, {
    prepare: !pooled,
    // Serverless-safe: one connection per function instance, don't hold it open
    // across freezes, and recycle so we never reuse a dead socket.
    max: 1,
    idle_timeout: 20,
    max_lifetime: 60 * 5,
    connect_timeout: 10,
    // Guard: a query that blocks on a lock fails at 15s instead of hanging the
    // whole 300s function invocation.
    connection: { statement_timeout: 15_000 },
  });
  return drizzle(client, { schema });
}

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    // Priority: DATABASE_URL (explicit deployment override) → Supabase pooled
    // (POSTGRES_URL) → Supabase direct fallback (POSTGRES_URL_NON_POOLING).
    // Prefer the pooled URL for serverless Supabase deployments so concurrent warm
    // function instances do not fan out into unbounded direct database sockets.
    const url =
      process.env["DATABASE_URL"] ??
      process.env["POSTGRES_URL"] ??
      process.env["POSTGRES_URL_NON_POOLING"];
    if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) environment variable is required");
    _db = createDb(url);
  }
  return _db;
}
