import { eq, and, or } from "drizzle-orm";
import { getDb } from "../db.js";
import { agents } from "@steadio/shared/schema";

const AGENT_CACHE = new Map<string, { agentId: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;

// Per-agent tool allowlist, resolved for the /v1 firewall (ELEAA-748). Cached
// briefly (same TTL as agent resolution) so the guardrail path doesn't pay a DB
// round-trip on every request; a config change takes effect within CACHE_TTL_MS.
const ALLOWLIST_CACHE = new Map<string, { allowedTools: string[]; guardrailMode: string; expiresAt: number }>();
const FAIL_CLOSED_ALLOWED_TOOLS = ["__steadio_no_agent_allowlist_match__"];

export interface AgentGuardrailConfig {
  allowedTools: string[];
  guardrailMode: "monitor" | "block";
}

// Resolve an agent's guardrail config from its DB row. If a team has any
// configured allowlist, missing/unknown agent refs fail closed to prevent
// callers from bypassing positive-security policy by omitting or spoofing
// the header.
export async function resolveAgentGuardrailConfig(
  teamId: string,
  agentRef: string | undefined | null,
): Promise<AgentGuardrailConfig> {
  const cacheKey = `${teamId}:${agentRef ?? "__missing__"}`;
  const cached = ALLOWLIST_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { allowedTools: cached.allowedTools, guardrailMode: cached.guardrailMode as "monitor" | "block" };
  }

  let allowedTools: string[] = [];
  let guardrailMode: "monitor" | "block" = "monitor";
  try {
    const db = getDb();
    const rows = agentRef
      ? await db
          .select({ allowedTools: agents.allowedTools, guardrailMode: agents.guardrailMode })
          .from(agents)
          .where(
            and(
              eq(agents.teamId, teamId),
              or(eq(agents.id, agentRef), eq(agents.externalId, agentRef)),
            ),
          )
          .limit(1)
      : [];
    const raw = rows[0]?.allowedTools;
    if (Array.isArray(raw)) {
      allowedTools = raw.filter((t): t is string => typeof t === "string" && t.length > 0);
    } else if (await teamHasConfiguredAllowlist(db, teamId)) {
      allowedTools = FAIL_CLOSED_ALLOWED_TOOLS;
      guardrailMode = "block";
    }
    if (rows[0]?.guardrailMode === "block") guardrailMode = "block";
  } catch {
    // A lookup failure must not allow a caller to bypass a configured allowlist.
    allowedTools = FAIL_CLOSED_ALLOWED_TOOLS;
    guardrailMode = "block";
  }

  ALLOWLIST_CACHE.set(cacheKey, { allowedTools, guardrailMode, expiresAt: Date.now() + CACHE_TTL_MS });
  return { allowedTools, guardrailMode };
}

export async function resolveAgentAllowedTools(
  teamId: string,
  agentRef: string | undefined | null,
): Promise<string[]> {
  return (await resolveAgentGuardrailConfig(teamId, agentRef)).allowedTools;
}

async function teamHasConfiguredAllowlist(
  db: ReturnType<typeof getDb>,
  teamId: string,
): Promise<boolean> {
  const rows = await db
    .select({ allowedTools: agents.allowedTools })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .limit(100);
  return rows.some((row) =>
    Array.isArray(row.allowedTools) &&
    row.allowedTools.some((t: unknown) => typeof t === "string" && t.length > 0),
  );
}

// Test/ops hook: drop cached allowlists so a just-written config is read fresh.
export function clearAgentAllowlistCache(): void {
  ALLOWLIST_CACHE.clear();
}

export async function resolveOrCreateAgent(
  teamId: string,
  externalId: string,
  provider?: string,
  model?: string,
): Promise<string> {
  const cacheKey = `${teamId}:${externalId}`;
  const cached = AGENT_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.agentId;
  }

  const db = getDb();

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.teamId, teamId), eq(agents.externalId, externalId)))
    .limit(1);

  if (existing[0]) {
    AGENT_CACHE.set(cacheKey, { agentId: existing[0].id, expiresAt: Date.now() + CACHE_TTL_MS });
    return existing[0].id;
  }

  const inserted = await db
    .insert(agents)
    .values({ teamId, name: externalId, externalId, provider: provider ?? null, model: model ?? null })
    .returning({ id: agents.id });

  const agentId = inserted[0]!.id;
  AGENT_CACHE.set(cacheKey, { agentId, expiresAt: Date.now() + CACHE_TTL_MS });
  return agentId;
}
