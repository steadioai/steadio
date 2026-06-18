export interface ProxyVariables {
  agentId: string;
  teamId: string;
  workflowId: string | null;
  apiKey: string;
  keyId: string;
}

export type ProxyEnv = { Variables: ProxyVariables };
