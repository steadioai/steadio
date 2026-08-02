export interface ProxyRequestLog {
  requestId: string;
  teamId: string;
  agentId: string;
  apiKeyId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  durationMs: number;
  outcome?: "success" | "blocked" | "upstream_error";
  statusCode?: number;
  upstreamStatus?: number;
  errorType?: string;
  errorMessage?: string;
  budgetMode?: "alert" | "throttle" | "kill" | "none";
}

export function logProxyRequest(fields: ProxyRequestLog): void {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      service: "proxy",
      event: "proxy_request",
      outcome: "success",
      ...fields,
    }) + "\n",
  );
}
