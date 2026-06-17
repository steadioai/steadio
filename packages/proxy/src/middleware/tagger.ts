import { createMiddleware } from "hono/factory";

// Extracts agent/team/workflow tags from request headers
export const taggerMiddleware = createMiddleware(async (c, next) => {
  const agentId = c.req.header("X-Agent-Id") ?? "untagged";
  const workflowId = c.req.header("X-Workflow-Id") ?? null;

  // Allow X-Team-Id to override the team derived from the API key
  const headerTeamId = c.req.header("X-Team-Id");
  if (headerTeamId) {
    c.set("teamId", headerTeamId);
  }

  c.set("agentId", agentId);
  c.set("workflowId", workflowId);

  await next();
});
