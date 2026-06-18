export interface ProxyConfig {
  port: number;
  redisUrl: string;
  openaiApiUrl: string;
  anthropicApiUrl: string;
  googleApiUrl: string;
  costEngineUrl: string;
  jwtSecret: string;
}

export function loadConfig(): ProxyConfig {
  return {
    port: Number(process.env["PORT"] ?? 3001),
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    openaiApiUrl:
      process.env["OPENAI_API_URL"] ?? "https://api.openai.com/v1",
    anthropicApiUrl:
      process.env["ANTHROPIC_API_URL"] ?? "https://api.anthropic.com",
    googleApiUrl:
      process.env["GOOGLE_API_URL"] ??
      "https://generativelanguage.googleapis.com",
    costEngineUrl:
      process.env["COST_ENGINE_URL"] ?? "http://localhost:3002",
    jwtSecret: process.env["JWT_SECRET"] ?? "dev-secret-change-in-production",
  };
}
