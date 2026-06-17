export interface ProxyVariables {
  agentId: string;
  teamId: string;
  workflowId: string | null;
  apiKey: string;
}

export type ProxyEnv = { Variables: ProxyVariables };
