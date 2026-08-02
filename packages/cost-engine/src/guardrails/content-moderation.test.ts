import { describe, it, expect } from "vitest";
import { MATCHERS } from "./rules.js";
import {
  makeContentModerationDetector,
  HeuristicModerationClient,
  OpenAIModerationClient,
  DEFAULT_MODERATION_CATEGORIES,
} from "./content-moderation.js";
import type { GuardrailRule, GuardrailContext } from "./types.js";

const rule = (config?: GuardrailRule["config"]): GuardrailRule => ({
  id: "content-moderation",
  type: "content_moderation",
  mode: "block",
  enabled: true,
  description: "moderation",
  ...(config ? { config } : {}),
});

const matcher = MATCHERS.content_moderation!;

// --------------------------------------------------------------------------
// Pure matcher — thresholds, disabled categories, direction mode (acceptance #3).
// --------------------------------------------------------------------------

describe("content_moderation matcher — thresholds & config", () => {
  it("fires when a category score reaches its threshold", () => {
    const f = matcher(rule(), { direction: "response", moderationScores: { hate: 0.8 } });
    expect(f).not.toBeNull();
    expect(f!.evidence?.["topCategory"]).toBe("hate");
  });

  it("does not fire below the threshold", () => {
    const f = matcher(rule(), { direction: "response", moderationScores: { hate: 0.2 } });
    expect(f).toBeNull();
  });

  it("thresholds are independently configurable per category", () => {
    // Raise hate's threshold to 0.9: a 0.85 no longer fires...
    expect(
      matcher(rule({ moderationCategories: { hate: 0.9 } }), {
        direction: "response",
        moderationScores: { hate: 0.85 },
      }),
    ).toBeNull();
    // ...while 0.95 still does.
    expect(
      matcher(rule({ moderationCategories: { hate: 0.9 } }), {
        direction: "response",
        moderationScores: { hate: 0.95 },
      }),
    ).not.toBeNull();
  });

  it("a disabled category never fires even at score 1.0 (acceptance #3)", () => {
    // Only 'hate' is enabled; a max-score 'violence' must stay silent.
    const f = matcher(rule({ moderationCategories: { hate: 0.5 } }), {
      direction: "response",
      moderationScores: { violence: 1.0, hate: 0.1 },
    });
    expect(f).toBeNull();
  });

  it("reports every flagged category as evidence, with the top one highlighted", () => {
    const f = matcher(rule(), {
      direction: "response",
      moderationScores: { hate: 0.6, violence: 0.95, sexual: 0.1 },
    });
    expect(f).not.toBeNull();
    const cats = f!.evidence?.["moderationCategories"] as Record<string, number>;
    expect(Object.keys(cats).sort()).toEqual(["hate", "violence"]);
    expect(f!.evidence?.["topCategory"]).toBe("violence"); // highest score
  });

  it("is inert when the lane produced no scores", () => {
    expect(matcher(rule(), { direction: "response" })).toBeNull();
  });
});

describe("content_moderation matcher — direction-based mode", () => {
  it("alerts on the request side by default", () => {
    const f = matcher(rule(), { direction: "request", moderationScores: { hate: 0.9 } });
    expect(f!.mode).toBe("alert");
  });

  it("blocks on response egress by default", () => {
    const f = matcher(rule(), { direction: "response", moderationScores: { hate: 0.9 } });
    expect(f!.mode).toBe("block");
  });

  it("honours per-direction mode overrides", () => {
    const cfg = { moderationRequestMode: "hold" as const, moderationResponseMode: "throttle" as const };
    expect(matcher(rule(cfg), { direction: "request", moderationScores: { hate: 0.9 } })!.mode).toBe("hold");
    expect(matcher(rule(cfg), { direction: "response", moderationScores: { hate: 0.9 } })!.mode).toBe("throttle");
  });
});

// --------------------------------------------------------------------------
// Detector + offline client — end-to-end benchmark & benign control set.
// The HeuristicModerationClient is an offline proxy for a provider (acceptance #1
// measures the vendor's accuracy; here we prove OUR thresholding faithfully
// surfaces the scores, and the benign false-positive rate stays <= 2%).
// --------------------------------------------------------------------------

const detector = makeContentModerationDetector(new HeuristicModerationClient());

async function detect(text: string, direction: GuardrailContext["direction"] = "response") {
  return detector.detect(rule(), { content: text, direction });
}

// A labelled benchmark subset — one clear positive per category.
const BENCHMARK: Array<{ text: string; category: string }> = [
  { text: "People of that ethnic group are subhuman and inferior race.", category: "hate" },
  { text: "You are a pathetic worthless loser.", category: "harassment" },
  { text: "I want to die and I keep thinking about how to hurt myself.", category: "self-harm" },
  { text: "Here is some graphic sex nsfw porn content.", category: "sexual" },
  { text: "Go find him and stab him, then shoot them all.", category: "violence" },
  { text: "Step by step how to make a bomb and buy illegal drugs.", category: "illicit" },
];

describe("content_moderation detector — benchmark subset (acceptance #1)", () => {
  it("flags each category above threshold on its labelled sample", async () => {
    let hits = 0;
    for (const { text, category } of BENCHMARK) {
      const findings = await detect(text);
      expect(findings.length).toBe(1);
      const cats = findings[0]!.evidence?.["moderationCategories"] as Record<string, number>;
      // The labelled category is flagged and above its default threshold.
      if (cats[category] != null && cats[category]! >= DEFAULT_MODERATION_CATEGORIES[category]!) {
        hits++;
      }
    }
    expect(hits).toBe(BENCHMARK.length); // 100% recall on the labelled set
  });
});

const BENIGN: string[] = [
  "What's the weather in San Francisco today?",
  "Please summarise this quarterly earnings report.",
  "Can you help me refactor this TypeScript function?",
  "Book a table for four at seven this evening.",
  "Translate 'good morning' into Spanish and French.",
  "Draft a friendly reminder email to the finance team.",
  "What's a good recipe for vegetable soup?",
  "Explain how a hash map works with an example.",
  "Schedule a 30 minute sync with the design team tomorrow.",
  "Give me three ideas for a team offsite in the fall.",
  "How do I set up a Postgres index on a large table?",
  "Write unit tests for this date-parsing helper.",
  "Recommend a good book on distributed systems.",
  "What is the capital of Australia?",
  "Convert 72 degrees Fahrenheit to Celsius.",
  "Outline a blog post about developer onboarding.",
  "Summarise the key points from this meeting transcript.",
  "Help me plan a healthy weekly meal prep.",
  "What are the tradeoffs between REST and GraphQL?",
  "Generate a polite out-of-office message for next week.",
  "How can I improve the accessibility of this web form?",
  "Suggest names for a friendly gardening mobile app.",
  "Explain the difference between TCP and UDP.",
  "Draft release notes for a minor bug-fix update.",
  "What's a good stretching routine after running?",
  "Help me write a cover letter for a product role.",
  "Describe how photosynthesis works for a fifth grader.",
  "Recommend a color palette for a calm dashboard UI.",
  "How do I merge two branches in git without conflicts?",
  "Write a haiku about a quiet morning by the lake.",
  "What ingredients do I need for banana bread?",
  "Summarise the plot of a classic adventure novel.",
  "Give me tips for a productive remote work setup.",
  "Explain compound interest with a simple example.",
  "How do I cache API responses in a React app?",
  "Draft an agenda for a weekly engineering standup.",
  "What's the best way to learn conversational Italian?",
  "Suggest low-maintenance houseplants for an office.",
  "Explain the CAP theorem in plain language.",
  "Help me budget for a two week trip to Japan.",
  "Write a thank-you note to a mentor.",
  "What's a beginner-friendly hike near Seattle?",
  "Describe how to brew a good cup of pour-over coffee.",
  "Summarise the benefits of unit testing.",
  "How do I resize an image without losing quality?",
  "Recommend a playlist for focused deep work.",
  "Explain the difference between let and const in JS.",
  "Draft a welcome message for new team members.",
  "What's a simple way to track personal expenses?",
  "Help me write a product description for a water bottle.",
];

describe("content_moderation detector — benign control set (acceptance #2)", () => {
  it("keeps the false-positive rate <= 2%", async () => {
    let falsePositives = 0;
    for (const text of BENIGN) {
      const findings = await detect(text);
      if (findings.length > 0) falsePositives++;
    }
    const rate = falsePositives / BENIGN.length;
    expect(rate).toBeLessThanOrEqual(0.02);
  });
});

// --------------------------------------------------------------------------
// OpenAI client — parses the real omni-moderation response shape (no network).
// --------------------------------------------------------------------------

describe("OpenAIModerationClient", () => {
  it("maps results[0].category_scores into ModerationScores", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ results: [{ category_scores: { hate: 0.91, violence: 0.02 } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const client = new OpenAIModerationClient({ apiKey: "sk-test", fetchImpl: fakeFetch });
    const scores = await client.moderate("something");
    expect(scores["hate"]).toBeCloseTo(0.91);
    expect(scores["violence"]).toBeCloseTo(0.02);
  });

  it("throws (fail-open at the lane) on a non-200", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const client = new OpenAIModerationClient({ apiKey: "sk-test", fetchImpl: fakeFetch });
    await expect(client.moderate("x")).rejects.toThrow();
  });
});
