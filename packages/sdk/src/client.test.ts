import { describe, it, expect, vi } from "vitest";
import { Steadio } from "./client.js";
import { SteadioBlockedError, SteadioThrottledError } from "./errors.js";

// A stub fetch that records the last request and returns a canned response.
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      status,
      ok: status < 400,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("Steadio — demo transport (keyless)", () => {
  const base = { baseUrl: "https://api.steadio.ai", transport: "demo" as const };

  it("hits the public demo endpoint and normalizes an allow", async () => {
    const { fn, calls } = stubFetch(200, { decision: { action: "allow", findings: [] } });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ content: "hello" });
    expect(v.action).toBe("allow");
    expect(v.allowed).toBe(true);
    expect((calls[0] as { url: string }).url).toBe(
      "https://api.steadio.ai/api/demo/guardrails/evaluate",
    );
  });

  it("normalizes a block with reason + determinedBy", async () => {
    const { fn } = stubFetch(200, {
      decision: {
        action: "block",
        findings: [
          { ruleId: "high-risk-action-gate", ruleType: "privileged_tool_call", mode: "block", reason: "Privileged tool blocked" },
        ],
      },
    });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ toolCalls: [{ name: "shell.exec" }] });
    expect(v.action).toBe("block");
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("Privileged tool blocked");
    expect(v.determinedBy?.ruleId).toBe("high-risk-action-gate");
  });

  it("surfaces approvalId on a hold", async () => {
    const { fn } = stubFetch(200, {
      decision: { action: "hold", findings: [{ ruleId: "r", ruleType: "privileged_tool_call", mode: "hold", reason: "held" }] },
      approval: { id: "dapr_abc123" },
    });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ content: "refund $4000" });
    expect(v.action).toBe("hold");
    expect(v.allowed).toBe(false);
    expect(v.approvalId).toBe("dapr_abc123");
  });

  it("passes direction + repeatCount through to the demo body", async () => {
    const { fn, calls } = stubFetch(200, { decision: { action: "allow", findings: [] } });
    const s = new Steadio({ ...base, fetch: fn });
    await s.check({ content: "x", direction: "response", repeatCount: 7 });
    const sent = JSON.parse((calls[0] as { init: RequestInit }).init.body as string);
    expect(sent.direction).toBe("response");
    expect(sent.repeatCount).toBe(7);
  });

  it("flattens ChatLike messages into content", async () => {
    const { fn, calls } = stubFetch(200, { decision: { action: "allow", findings: [] } });
    const s = new Steadio({ ...base, fetch: fn });
    await s.check({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
    const sent = JSON.parse((calls[0] as { init: RequestInit }).init.body as string);
    expect(sent.content).toBe("a\nb");
  });
});

describe("Steadio — v1 transport (authenticated)", () => {
  const base = { baseUrl: "https://api.steadio.ai", apiKey: "st_test", transport: "v1" as const };

  it("sends the X-SteadIO-Key header to /v1", async () => {
    const { fn, calls } = stubFetch(503, { error: "gateway_unavailable" });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ content: "hi" });
    expect((calls[0] as { url: string }).url).toBe("https://api.steadio.ai/v1/chat/completions");
    const headers = (calls[0] as { init: RequestInit }).init.headers as Record<string, string>;
    expect(headers["X-SteadIO-Key"]).toBe("st_test");
    expect(v.action).toBe("allow"); // 503 gateway_unavailable == guardrail passed
  });

  it("maps 403 -> block", async () => {
    const { fn } = stubFetch(403, {
      error: "guardrail_blocked",
      action: "block",
      guardrail: { action: "block", findings: [{ ruleId: "r", ruleType: "privileged_tool_call", mode: "block", reason: "nope" }] },
    });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ toolCalls: [{ name: "shell.exec" }] });
    expect(v.action).toBe("block");
    expect(v.httpStatus).toBe(403);
  });

  it("maps 429 -> throttle", async () => {
    const { fn } = stubFetch(429, { error: "guardrail_blocked", action: "throttle", guardrail: { action: "throttle", findings: [] } });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ content: "ssn 123-45-6789" });
    expect(v.action).toBe("throttle");
  });

  it("maps 202 hold -> hold with approvalId + resumeToken", async () => {
    const { fn } = stubFetch(202, {
      error: "guardrail_held",
      action: "hold",
      approvalId: "apr_1",
      resumeToken: "tok_1",
      guardrail: { action: "hold", findings: [{ ruleId: "r", ruleType: "privileged_tool_call", mode: "hold", reason: "held" }] },
    });
    const s = new Steadio({ ...base, fetch: fn });
    const v = await s.check({ toolCalls: [{ name: "refund.issue", arguments: { amount: 4000 } }] });
    expect(v.action).toBe("hold");
    expect(v.approvalId).toBe("apr_1");
    expect(v.resumeToken).toBe("tok_1");
  });

  it("throws on a 401 invalid key", async () => {
    const { fn } = stubFetch(401, { error: "invalid_api_key" });
    const s = new Steadio({ ...base, fetch: fn });
    await expect(s.check({ content: "x" })).rejects.toThrow(/Invalid or missing/);
  });
});

describe("Steadio#guard", () => {
  const base = { baseUrl: "https://api.steadio.ai", transport: "demo" as const };

  it("runs the callback on allow and returns its value", async () => {
    const { fn } = stubFetch(200, { decision: { action: "allow", findings: [] } });
    const s = new Steadio({ ...base, fetch: fn });
    const out = await s.guard({ content: "hi" }, () => "llm-result");
    expect(out).toBe("llm-result");
  });

  it("throws SteadioBlockedError and never runs the callback on block", async () => {
    const { fn } = stubFetch(200, { decision: { action: "block", findings: [{ ruleId: "r", ruleType: "privileged_tool_call", mode: "block", reason: "nope" }] } });
    const s = new Steadio({ ...base, fetch: fn });
    const run = vi.fn(() => "should-not-run");
    await expect(s.guard({ toolCalls: [{ name: "shell.exec" }] }, run)).rejects.toBeInstanceOf(SteadioBlockedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("throws SteadioHeldError with the approvalId on hold", async () => {
    const { fn } = stubFetch(200, {
      decision: { action: "hold", findings: [{ ruleId: "r", ruleType: "privileged_tool_call", mode: "hold", reason: "held" }] },
      approval: { id: "dapr_x" },
    });
    const s = new Steadio({ ...base, fetch: fn });
    await expect(s.guard({ content: "refund $9999" }, () => "x")).rejects.toMatchObject({
      name: "SteadioHeldError",
      approvalId: "dapr_x",
    });
  });

  it("throws SteadioThrottledError on throttle", async () => {
    const { fn } = stubFetch(200, { decision: { action: "throttle", findings: [] } });
    const s = new Steadio({ ...base, fetch: fn });
    await expect(s.guard({ content: "x" }, () => "x")).rejects.toBeInstanceOf(SteadioThrottledError);
  });
});
