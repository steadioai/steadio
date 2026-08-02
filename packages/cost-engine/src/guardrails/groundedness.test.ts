// Groundedness / faithfulness gate (ELEAA-790 / G2). Proves the pure verdict
// logic (acceptance #2 inertness, #3 redacted evidence) and the baseline judge.
// Acceptance #1 (precision/recall on a labeled set) is met by the A0 model judge
// swapped in behind the GroundednessJudge seam; here we smoke the baseline's
// direction only.

import { describe, it, expect } from "vitest";
import { evaluate } from "./engine.js";
import { evaluateWithSignals } from "./signal-lane.js";
import type { GuardrailContext, GuardrailRule } from "./types.js";
import {
  lexicalGroundednessJudge,
  makeGroundednessDetector,
  runGroundednessJudge,
  splitClaims,
  type GroundednessJudge,
} from "./groundedness-judge.js";
import { extractGuardrailContext } from "./gateway-adapter.js";

// A single groundedness rule so tests read the verdict directly (DEFAULT_RULES
// also work — nothing else fires on plain text with source context).
function groundednessRules(overrides: Partial<GuardrailRule> = {}): GuardrailRule[] {
  return [
    {
      id: "groundedness-test",
      type: "groundedness",
      mode: "alert",
      enabled: true,
      description: "test",
      config: { groundednessThreshold: 0.75 },
      ...overrides,
    },
  ];
}

const SOURCE =
  "The Eiffel Tower is located in Paris and is 330 meters tall. It was completed in 1889.";

describe("groundedness matcher — inertness (acceptance #2)", () => {
  it("is inert on a response with no source context supplied", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The tower is 500 meters tall.",
      groundednessScore: 0.1, // present, but must be ignored without source
    };
    expect(evaluate(ctx, groundednessRules()).action).toBe("allow");
  });

  it("is inert on the request side even with source + a low score", () => {
    const ctx: GuardrailContext = {
      direction: "request",
      content: "The tower is 500 meters tall.",
      sourceContext: SOURCE,
      groundednessScore: 0.1,
    };
    expect(evaluate(ctx, groundednessRules()).action).toBe("allow");
  });

  it("fails open when source is present but the judge produced no score", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The tower is 500 meters tall.",
      sourceContext: SOURCE,
      // no groundednessScore -> judge did not run
    };
    expect(evaluate(ctx, groundednessRules()).action).toBe("allow");
  });

  it("requireSourceContext flags a RAG response that arrived with no context", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "Some answer.",
    };
    const d = evaluate(ctx, groundednessRules({ config: { requireSourceContext: true } }));
    expect(d.action).toBe("alert");
    expect(d.determinedBy?.evidence?.["groundedness"]).toMatchObject({ requireSourceContext: true });
  });
});

describe("groundedness matcher — verdict + evidence", () => {
  it("passes an answer at/above threshold", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The Eiffel Tower is in Paris.",
      sourceContext: SOURCE,
      groundednessScore: 0.9,
    };
    expect(evaluate(ctx, groundednessRules()).action).toBe("allow");
  });

  it("fires below threshold at the configured mode, with score + threshold evidence", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The tower is 500 meters tall.",
      sourceContext: SOURCE,
      groundednessScore: 0.4,
      unsupportedClaims: ["The tower is 500 meters tall."],
    };
    const d = evaluate(ctx, groundednessRules());
    expect(d.action).toBe("alert");
    const ev = d.determinedBy?.evidence?.["groundedness"] as Record<string, unknown>;
    expect(ev["score"]).toBe(0.4);
    expect(ev["threshold"]).toBe(0.75);
    expect(ev["unsupportedClaims"]).toEqual(["The tower is 500 meters tall."]);
  });

  it("honors a stricter mode for regulated buyers (block)", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "Fabricated.",
      sourceContext: SOURCE,
      groundednessScore: 0.2,
    };
    expect(evaluate(ctx, groundednessRules({ mode: "block" })).action).toBe("block");
  });

  it("respects a custom threshold", () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "x",
      sourceContext: SOURCE,
      groundednessScore: 0.6,
    };
    // default 0.75 -> fires; custom 0.5 -> passes
    expect(evaluate(ctx, groundednessRules()).action).toBe("alert");
    expect(
      evaluate(ctx, groundednessRules({ config: { groundednessThreshold: 0.5 } })).action,
    ).toBe("allow");
  });
});

describe("groundedness evidence redaction (acceptance #3)", () => {
  it("masks a secret and PII echoed inside an unsupported claim span", () => {
    const leaked =
      "Contact admin@example.com with key sk-abcdefghijklmnop12345 to reset.";
    const ctx: GuardrailContext = {
      direction: "response",
      content: leaked,
      sourceContext: SOURCE,
      groundednessScore: 0.1,
      unsupportedClaims: [leaked],
    };
    const d = evaluate(ctx, groundednessRules());
    const ev = d.determinedBy?.evidence?.["groundedness"] as Record<string, unknown>;
    const claims = ev["unsupportedClaims"] as string[];
    const joined = claims.join(" ");
    expect(joined).not.toContain("sk-abcdefghijklmnop12345");
    expect(joined).not.toContain("admin@example.com");
    expect(joined).toContain("***"); // masked form present
  });

  it("caps very long spans so evidence stays small", () => {
    const long = "The claim is wrong. ".repeat(60);
    const ctx: GuardrailContext = {
      direction: "response",
      content: long,
      sourceContext: SOURCE,
      groundednessScore: 0.1,
      unsupportedClaims: [long],
    };
    const d = evaluate(ctx, groundednessRules());
    const ev = d.determinedBy?.evidence?.["groundedness"] as Record<string, unknown>;
    expect((ev["unsupportedClaims"] as string[])[0]!.length).toBeLessThanOrEqual(241);
  });
});

describe("lexical baseline judge", () => {
  it("splits an answer into claim-sized spans", () => {
    expect(splitClaims("A is true. B is false!\nC is unknown?")).toEqual([
      "A is true.",
      "B is false!",
      "C is unknown?",
    ]);
  });

  it("scores a faithful answer high and returns no unsupported claims", () => {
    const r = lexicalGroundednessJudge("The Eiffel Tower is in Paris.", SOURCE);
    expect(r.score).toBeGreaterThanOrEqual(0.75);
    expect(r.unsupportedClaims).toHaveLength(0);
  });

  it("scores a fabricated answer low and surfaces the offending claim", () => {
    const r = lexicalGroundednessJudge(
      "The Eiffel Tower is in Paris. The tower hosts a submarine museum on floor nine.",
      SOURCE,
    );
    expect(r.score).toBeLessThan(0.75);
    expect(r.unsupportedClaims.join(" ")).toContain("submarine");
  });

  it("directionally separates a small labeled faithful/unfaithful set", () => {
    // Smoke of acceptance #1's *direction* with the baseline; the numeric
    // precision/recall bar is cleared by the A0 model judge behind the same seam.
    const faithful = ["The Eiffel Tower is in Paris.", "The tower is 330 meters tall."];
    const unfaithful = ["The tower is 500 meters tall.", "The tower is in Berlin."];
    for (const a of faithful) {
      expect(lexicalGroundednessJudge(a, SOURCE).score).toBeGreaterThanOrEqual(0.75);
    }
    for (const a of unfaithful) {
      expect(lexicalGroundednessJudge(a, SOURCE).score).toBeLessThan(0.75);
    }
  });
});

describe("runGroundednessJudge (fail-open wrapper)", () => {
  it("returns null with no response or no source", async () => {
    expect(await runGroundednessJudge(lexicalGroundednessJudge, "", SOURCE)).toBeNull();
    expect(await runGroundednessJudge(lexicalGroundednessJudge, "answer", "")).toBeNull();
    expect(await runGroundednessJudge(lexicalGroundednessJudge, "answer", ["  "])).toBeNull();
  });

  it("clamps the score into 0..1 and never throws on a bad judge", async () => {
    const badJudge = () => {
      throw new Error("model down");
    };
    expect(await runGroundednessJudge(badJudge, "answer", SOURCE)).toBeNull();
    const hot = await runGroundednessJudge(() => ({ score: 5, unsupportedClaims: [] }), "a", SOURCE);
    expect(hot?.score).toBe(1);
  });

  it("feeds a real judge result through evaluate end-to-end", async () => {
    const response = "The tower is 500 meters tall and sits in Berlin.";
    const judged = await runGroundednessJudge(lexicalGroundednessJudge, response, SOURCE);
    expect(judged).not.toBeNull();
    const ctx: GuardrailContext = {
      direction: "response",
      content: response,
      sourceContext: SOURCE,
      groundednessScore: judged!.score,
      unsupportedClaims: judged!.unsupportedClaims,
    };
    expect(evaluate(ctx, groundednessRules()).action).toBe("alert");
  });
});

// The A0-lane detector (ELEAA-787 dependency): the judge runs inside the async
// signal lane and its score reaches the pure matcher via evaluateWithSignals —
// no groundednessScore is pre-supplied on ctx (that's the detector's job).
describe("groundedness detector on the A0 signal lane", () => {
  const detector = makeGroundednessDetector(lexicalGroundednessJudge);

  it("flags a fabricated RAG answer end-to-end (no pre-supplied score)", async () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The Eiffel Tower is in Paris. The tower is 500 meters tall.",
      sourceContext: SOURCE,
    };
    const d = await evaluateWithSignals(ctx, groundednessRules(), [detector]);
    expect(d.action).toBe("alert");
    const ev = d.determinedBy?.evidence?.["groundedness"] as Record<string, unknown>;
    expect(ev["unsupportedClaims"]).toEqual(["The tower is 500 meters tall."]);
  });

  it("passes a faithful RAG answer end-to-end", async () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The Eiffel Tower is in Paris. It is 330 meters tall.",
      sourceContext: SOURCE,
    };
    const d = await evaluateWithSignals(ctx, groundednessRules(), [detector]);
    expect(d.action).toBe("allow");
  });

  it("stays inert on the request side (never calls the judge)", async () => {
    let called = false;
    const spyJudge: GroundednessJudge = (r, s) => {
      called = true;
      return lexicalGroundednessJudge(r, s);
    };
    const ctx: GuardrailContext = {
      direction: "request",
      content: "The tower is 500 meters tall.",
      sourceContext: SOURCE,
    };
    const d = await evaluateWithSignals(ctx, groundednessRules(), [
      makeGroundednessDetector(spyJudge),
    ]);
    expect(d.action).toBe("allow");
    expect(called).toBe(false);
  });

  it("is inert with no source context (acceptance #2) through the lane", async () => {
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The tower is 500 meters tall.",
    };
    const d = await evaluateWithSignals(ctx, groundednessRules(), [detector]);
    expect(d.action).toBe("allow");
  });

  it("fails open when the judge model throws (no spurious block)", async () => {
    const badJudge: GroundednessJudge = () => {
      throw new Error("model down");
    };
    const ctx: GuardrailContext = {
      direction: "response",
      content: "The tower is 500 meters tall.",
      sourceContext: SOURCE,
    };
    const d = await evaluateWithSignals(ctx, groundednessRules({ mode: "block" }), [
      makeGroundednessDetector(badJudge),
    ]);
    expect(d.action).toBe("allow");
  });
});

// Acceptance #1: a labeled faithful/unfaithful RAG set. The lexical baseline is
// evaluated at the default 0.75 threshold on the fabrication failure mode it is
// built to catch (wrong number / wrong named entity). The A0 model judge plugs in
// behind the same seam to also cover paraphrase / semantic drift; this harness is
// what it is measured against.
describe("groundedness acceptance #1 — precision/recall on a labeled set", () => {
  const DOC =
    "Acme Corp was founded in 2011 by Jane Doe in Boston. The company employs 450 " +
    "people and raised 12 million dollars in Series A funding. Its flagship product " +
    "is the Widget Pro, released in 2018.";

  // label true = UNFAITHFUL (the positive class we want to flag).
  const LABELED: Array<{ answer: string; unfaithful: boolean }> = [
    { answer: "Acme Corp was founded in 2011. It was started by Jane Doe.", unfaithful: false },
    { answer: "The company employs 450 people. It is based in Boston.", unfaithful: false },
    { answer: "Acme raised 12 million dollars. Its flagship product is the Widget Pro.", unfaithful: false },
    { answer: "Jane Doe founded Acme in Boston. The Widget Pro was released in 2018.", unfaithful: false },
    { answer: "Acme Corp has 450 employees. The company raised 12 million dollars.", unfaithful: false },
    { answer: "Acme Corp was founded in 2011. It employs 900 people.", unfaithful: true },
    { answer: "Jane Doe founded the company. It is headquartered in Denver.", unfaithful: true },
    { answer: "The Widget Pro was released in 2018. Acme raised 50 million dollars.", unfaithful: true },
    { answer: "Acme employs 450 people. The CEO is John Smith.", unfaithful: true },
    { answer: "The company is based in Boston. It was founded in 1995.", unfaithful: true },
  ];

  it("clears >= 0.75 precision and >= 0.70 recall at the default threshold", () => {
    const THRESHOLD = 0.75;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { answer, unfaithful } of LABELED) {
      const flagged = lexicalGroundednessJudge(answer, DOC).score < THRESHOLD;
      if (flagged && unfaithful) tp += 1;
      else if (flagged && !unfaithful) fp += 1;
      else if (!flagged && unfaithful) fn += 1;
    }
    const precision = tp / (tp + fp || 1);
    const recall = tp / (tp + fn || 1);
    expect(precision).toBeGreaterThanOrEqual(0.75);
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });
});

describe("gateway adapter carries sourceContext (integration surface)", () => {
  it("reads a top-level string source_context off the /v1 body", () => {
    const ctx = extractGuardrailContext({
      messages: [{ role: "user", content: "How tall is it?" }],
      source_context: SOURCE,
    });
    expect(ctx.sourceContext).toBe(SOURCE);
  });

  it("reads a camelCase array of passage objects", () => {
    const ctx = extractGuardrailContext({
      messages: [{ role: "user", content: "q" }],
      sourceContext: [{ text: "passage one" }, { content: "passage two" }, "passage three"],
    });
    expect(ctx.sourceContext).toEqual(["passage one", "passage two", "passage three"]);
  });

  it("leaves sourceContext undefined for a non-RAG request", () => {
    const ctx = extractGuardrailContext({ messages: [{ role: "user", content: "hi" }] });
    expect(ctx.sourceContext).toBeUndefined();
  });
});
