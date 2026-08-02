import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { guardrailRules } from "@steadio/shared/schema";
import { DEFAULT_RULES } from "../guardrails/rules.js";
import type { GuardrailRule, GuardrailRuleConfig, GuardrailRuleType, GuardrailMode } from "../guardrails/types.js";

export interface WorkspaceRuleRow {
  ruleId: string;
  ruleType: string;
  mode: string;
  enabled: boolean;
  config: unknown;
  description: string | null;
}

// Pure merge: workspace rows override matching DEFAULT_RULES by id, append new ones.
export function mergeWorkspaceRules(
  defaults: readonly GuardrailRule[],
  rows: readonly WorkspaceRuleRow[],
): GuardrailRule[] {
  if (rows.length === 0) return [...defaults];

  const overrideMap = new Map(rows.map((r) => [r.ruleId, r]));

  const merged: GuardrailRule[] = defaults.map((dflt) => {
    const override = overrideMap.get(dflt.id);
    if (!override) return dflt;
    const cfg = override.config as Record<string, unknown> | null;
    return {
      id: override.ruleId,
      type: override.ruleType as GuardrailRuleType,
      mode: override.mode as GuardrailMode,
      enabled: override.enabled,
      description: override.description ?? dflt.description,
      ...(cfg && Object.keys(cfg).length > 0 ? { config: cfg as GuardrailRuleConfig } : dflt.config ? { config: dflt.config } : {}),
    };
  });

  const defaultIds = new Set(defaults.map((r) => r.id));
  for (const row of rows) {
    if (!defaultIds.has(row.ruleId)) {
      const cfg = row.config as Record<string, unknown> | null;
      merged.push({
        id: row.ruleId,
        type: row.ruleType as GuardrailRuleType,
        mode: row.mode as GuardrailMode,
        enabled: row.enabled,
        description: row.description ?? "",
        ...(cfg && Object.keys(cfg).length > 0 ? { config: cfg as GuardrailRuleConfig } : {}),
      });
    }
  }

  return merged;
}

const CACHE = new Map<string, { rules: GuardrailRule[]; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;

export async function resolveWorkspaceRules(teamId: string): Promise<GuardrailRule[]> {
  const cached = CACHE.get(teamId);
  if (cached && cached.expiresAt > Date.now()) return cached.rules;

  let rows: WorkspaceRuleRow[] = [];

  try {
    const db = getDb();
    rows = await db
      .select({
        ruleId: guardrailRules.ruleId,
        ruleType: guardrailRules.ruleType,
        mode: guardrailRules.mode,
        enabled: guardrailRules.enabled,
        config: guardrailRules.config,
        description: guardrailRules.description,
      })
      .from(guardrailRules)
      .where(eq(guardrailRules.teamId, teamId));
  } catch {
    return DEFAULT_RULES;
  }

  const merged = rows.length === 0 ? DEFAULT_RULES : mergeWorkspaceRules(DEFAULT_RULES, rows);
  CACHE.set(teamId, { rules: merged, expiresAt: Date.now() + CACHE_TTL_MS });
  return merged;
}

export function clearWorkspaceRulesCache(): void {
  CACHE.clear();
}
