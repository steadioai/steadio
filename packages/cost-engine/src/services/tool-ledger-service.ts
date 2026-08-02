import { getDb } from "../db.js";
import { toolLedger } from "@steadio/shared/schema";
import type { ToolLedgerEntry } from "../guardrails/types.js";

export interface ToolLedgerInput {
  teamId: string;
  entries: ToolLedgerEntry[];
}

export async function writeToolLedger(input: ToolLedgerInput): Promise<void> {
  const { teamId, entries } = input;
  if (entries.length === 0) return;
  await getDb()
    .insert(toolLedger)
    .values(
      entries.map((e) => ({
        teamId,
        agentId: e.agentId ?? null,
        identity: e.identity ?? null,
        toolName: e.toolName,
        paramsMasked: e.paramsMasked,
        resultStatus: e.resultStatus,
        ruleId: e.ruleId ?? null,
        resultHash: e.resultHash,
        ts: new Date(e.ts),
      })),
    );
}
