export class SteadIOError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "SteadIOError";
  }
}

export class BudgetExceededError extends SteadIOError {
  constructor(
    public readonly budgetId: string,
    public readonly agentId: string,
    public readonly capAmountCents?: number,
    public readonly currentSpendCents?: number,
    public readonly resetAt?: string,
  ) {
    super(
      `Budget ${budgetId} exceeded for agent ${agentId}`,
      "BUDGET_EXCEEDED",
      402,
    );
    this.name = "BudgetExceededError";
  }
}

export class RunawayDetectedError extends SteadIOError {
  constructor(
    public readonly agentId: string,
    public readonly triggerType: "velocity" | "loop",
    public readonly cooldownUntil?: string,
    public readonly evidence?: Record<string, unknown>,
  ) {
    super(
      `Runaway detected for agent ${agentId} (${triggerType})`,
      "RUNAWAY_DETECTED",
      429,
    );
    this.name = "RunawayDetectedError";
  }
}

export class UnauthorizedError extends SteadIOError {
  constructor(message = "Invalid or missing API key") {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends SteadIOError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends SteadIOError {
  constructor(
    message: string,
    public readonly field?: string,
  ) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}
