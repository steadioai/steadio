export type AlertType =
  | "budget_warning"
  | "budget_exceeded"
  | "runaway_detected"
  | "tool_call_failure";

export type AlertChannel = "webhook" | "slack";

export interface AlertConfig {
  id: string;
  teamId: string;
  alertType: AlertType;
  channel: AlertChannel;
  destination: string; // webhook URL or Slack webhook URL
  createdAt: Date;
}

export interface AlertPayload {
  alertType: AlertType;
  agentId?: string | undefined;
  teamId?: string | undefined;
  timestamp: Date;
  data: Record<string, unknown>;
}
