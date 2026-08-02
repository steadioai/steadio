// @steadio/sdk — public entrypoint (ELEAA-679, Hackathon Track G).
//
//   import { Steadio } from "@steadio/sdk";
//   const steadio = new Steadio();                 // keyless demo, or { apiKey }
//   const verdict = await steadio.check({ content, toolCalls });
//   if (!verdict.allowed) { /* block | hold | throttle */ }
//
// Thin wrapper over the guardrails endpoints already live on api.steadio.ai —
// no new detectors, pure adoption / DX.

export { Steadio, DEFAULT_BASE_URL } from "./client.js";
export type { SteadioOptions } from "./client.js";
export type {
  AgentAction,
  ChatLike,
  Verdict,
  Finding,
  ToolCall,
  GuardrailAction,
  GuardrailRuleType,
} from "./types.js";
export {
  SteadioGuardrailError,
  SteadioBlockedError,
  SteadioThrottledError,
  SteadioHeldError,
  SteadioTransportError,
} from "./errors.js";
