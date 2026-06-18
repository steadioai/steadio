import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let db: ReturnType<typeof drizzle> | null = null;

export function getDb(databaseUrl?: string) {
  if (db) return db;
  const url = databaseUrl ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: url });
  db = drizzle(pool, { schema });
  return db;
}

export type Db = ReturnType<typeof getDb>;
