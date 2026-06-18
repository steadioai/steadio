const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
}

export interface AgentRow {
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface TeamRow {
  teamId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  agentCount: number;
}

export interface HistoryBucket {
  bucket: string;
  totalCostUsd: number;
  requestCount: number;
}

export interface AttributionSummary {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  avgCostPerRequest: number;
  topModels: Array<{ model: string; costUsd: number; requestCount: number }>;
}

export interface ModelBreakdown {
  model: string;
  totalCostUsd: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostEventRow {
  id: string;
  agentId: string;
  teamId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  requestId: string;
  latencyMs: number;
  statusCode: number;
  streaming: boolean;
  recordedAt: string;
}

export interface AgentDetail {
  agentId: string;
  period: string;
  totals: {
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
  };
  byModel: ModelBreakdown[];
  recent: CostEventRow[];
}

export interface BudgetRow {
  id: string;
  scope: string;
  scopeId: string;
  period: string;
  capUsd: number;
  warningThresholdPercent: number;
  enforcementMode: string;
  throttleModelId?: string;
  currentSpendUsd: number;
  utilizationPercent: number;
  periodStart: string;
  periodEnd: string;
}

export interface RunawayEvent {
  id: string;
  agentId: string;
  teamId: string;
  triggerType: string;
  tokenCount: number;
  estimatedCostUsd: number;
  actionTaken: string;
  cooldownUntil: string | null;
  overriddenAt: string | null;
  overrideReason: string | null;
  detectedAt: string;
}

export interface LiveCostEvent {
  agentId: string;
  teamId: string;
  model: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestId: string;
  recordedAt: string;
}

export interface ToolCallRow {
  id: string;
  agentId: string;
  toolName: string;
  resultStatus: string;
  errorType: string | null;
  latencyMs: number | null;
  recordedAt: string;
  requestId: string;
  costUsd: number;
}

export interface TopTool {
  toolName: string;
  callCount: number;
  errorCount: number;
}

export interface ToolCallsResponse {
  toolCalls: ToolCallRow[];
  topTools: TopTool[];
  total: number;
  limit: number;
  offset: number;
  period: string;
  from: string;
  to: string;
}

export const api = {
  attribution: {
    agents: (teamId?: string, period = "7d") =>
      get<{ agents: AgentRow[]; period: string; from: string; to: string }>(
        `/attribution/agents?period=${period}${teamId ? `&teamId=${teamId}` : ""}`
      ),
    agentDetail: (agentId: string, period = "7d") =>
      get<AgentDetail>(`/attribution/agents/${encodeURIComponent(agentId)}?period=${period}`),
    teams: (period = "7d") =>
      get<{ teams: TeamRow[]; period: string; from: string; to: string }>(
        `/attribution/teams?period=${period}`
      ),
    history: (opts: { period?: string; agentId?: string; teamId?: string }) => {
      const params = new URLSearchParams();
      if (opts.period) params.set("period", opts.period);
      if (opts.agentId) params.set("agentId", opts.agentId);
      if (opts.teamId) params.set("teamId", opts.teamId);
      return get<{ history: HistoryBucket[]; period: string; from: string; to: string }>(
        `/attribution/history?${params.toString()}`
      );
    },
    summary: (opts: { agentId?: string; teamId?: string; period?: string }) => {
      const params = new URLSearchParams();
      if (opts.agentId) params.set("agentId", opts.agentId);
      if (opts.teamId) params.set("teamId", opts.teamId);
      if (opts.period) params.set("period", opts.period);
      return get<{ summary: AttributionSummary; period: string }>(
        `/attribution/summary?${params.toString()}`
      );
    },
  },
  budgets: {
    list: (scope?: string, scopeId?: string) => {
      const params = new URLSearchParams();
      if (scope) params.set("scope", scope);
      if (scopeId) params.set("scopeId", scopeId);
      return get<{ budgets: BudgetRow[] }>(`/budgets?${params.toString()}`);
    },
    create: (body: {
      scope: string;
      scopeId: string;
      period: string;
      capUsd: number;
      warningThresholdPercent?: number;
      enforcementMode: string;
      throttleModelId?: string;
    }) => post<{ budget: BudgetRow }>("/budgets", body),
    delete: (id: string) => del(`/budgets/${id}`),
  },
  runaways: {
    list: (opts?: { agentId?: string; teamId?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (opts?.agentId) params.set("agentId", opts.agentId);
      if (opts?.teamId) params.set("teamId", opts.teamId);
      if (opts?.limit) params.set("limit", String(opts.limit));
      return get<{ runaways: RunawayEvent[] }>(`/runaways?${params.toString()}`);
    },
  },
  costs: {
    toolCalls: (opts: { agentId?: string; period?: string; limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (opts.agentId) params.set("agentId", opts.agentId);
      if (opts.period) params.set("period", opts.period);
      if (opts.limit != null) params.set("limit", String(opts.limit));
      if (opts.offset != null) params.set("offset", String(opts.offset));
      return get<ToolCallsResponse>(`/costs/tool-calls?${params.toString()}`);
    },
  },
};
