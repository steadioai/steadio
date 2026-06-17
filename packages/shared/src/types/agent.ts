export interface AgentTag {
  agentId: string;
  teamId?: string | undefined;
  workflowId?: string | undefined;
}

export interface Agent {
  id: string;
  teamId: string | null;
  name: string;
  createdAt: Date;
}

export interface Team {
  id: string;
  name: string;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  keyHash: string;
  teamId: string;
  name: string;
  createdAt: Date;
  revokedAt: Date | null;
}
