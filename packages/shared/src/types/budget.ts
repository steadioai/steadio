export type BudgetPeriod = "daily" | "weekly" | "monthly";
export type BudgetEnforcementMode = "alert" | "throttle" | "kill";
export type BudgetScope = "agent" | "team";

export interface Budget {
  id: string;
  scope: BudgetScope;
  scopeId: string; // agentId or teamId
  period: BudgetPeriod;
  capUsd: number;
  warningThresholdPercent: number; // default 80
  enforcementMode: BudgetEnforcementMode;
  throttleModelId?: string | undefined; // model to downgrade to in throttle mode
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetState {
  budgetId: string;
  scopeId: string;
  period: BudgetPeriod;
  periodStart: Date;
  periodEnd: Date;
  currentSpendUsd: number;
  capUsd: number;
  utilizationPercent: number;
  warningFired: boolean;
  enforcementFired: boolean;
  enforcementMode: BudgetEnforcementMode;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: "budget_exceeded" | "budget_warning" | undefined;
  budgetId?: string | undefined;
  agentId?: string | undefined;
  capAmountUsd?: number | undefined;
  currentSpendUsd?: number | undefined;
  resetAt?: Date | undefined;
  throttleModel?: string | undefined;
}
