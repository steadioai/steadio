export interface ProxyVariables {
  teamId: string;
  agentId: string;
  workflowId: string | null;
  apiKey: string;
}

export type ProxyEnv = { Variables: ProxyVariables };
