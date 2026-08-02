// G3 — toxicity / content-moderation detector (ELEAA-789).
//
// The first detector on the A0 async signal lane (signal-lane.ts). It answers one
// question every Cluster-A product answers: does this content cross a
// hate / harassment / self-harm / sexual / violence / illicit line? It runs both
// directions — alert on the request, block on response egress (configurable).
//
// The moderation *thresholding* logic lives in the pure matcher (rules.ts,
// matchContentModeration) so it is deterministic and unit-tested there. This
// module is the impure half: it fetches the category scores and feeds them into
// that matcher via the signal lane. Two shapes of client ship:
//
//   - `OpenAIModerationClient` — the real provider client (omni-moderation-latest,
//     free/near-free + fast). Wire it in when a provider key is provisioned.
//   - `HeuristicModerationClient` — a dependency-free, offline lexical baseline. It
//     is NOT production accuracy (that's the provider's job) but it gives the whole
//     path real text->score behaviour so the demo route and the benchmark tests run
//     with zero network and zero key. Mirrors the groundedness lexical baseline.

import { MATCHERS, DEFAULT_MODERATION_CATEGORIES } from "./rules.js";
import type {
  GuardrailContext,
  GuardrailFinding,
  GuardrailRule,
} from "./types.js";
import type { SignalDetector } from "./signal-lane.js";

// A moderation score per category, 0..1. The exact category names follow the
// standard provider taxonomy (hate, harassment, self-harm, sexual, violence,
// illicit and their sub-categories) so a real provider's output maps in directly.
export type ModerationScores = Record<string, number>;

export interface ModerationClient {
  // Score one blob of text. MAY reject / be slow — the signal lane fails open, so
  // an error here means "did not run", never a spurious block.
  moderate(text: string): Promise<ModerationScores>;
}

// --------------------------------------------------------------------------
// Detector — the SignalDetector the A0 lane runs. Picks the text for the current
// direction, scores it, and hands the scores to the pure matcher so thresholding
// stays in one place. Emits at most one finding (the pure matcher collapses the
// flagged categories into a single verdict with the whole set as evidence).
// --------------------------------------------------------------------------

export function makeContentModerationDetector(client: ModerationClient): SignalDetector {
  return {
    type: "content_moderation",
    async detect(rule: GuardrailRule, ctx: GuardrailContext): Promise<GuardrailFinding[]> {
      const text = ctx.content ?? "";
      if (!text.trim()) return [];
      const scores = await client.moderate(text);
      const matcher = MATCHERS.content_moderation;
      if (!matcher) return [];
      // Re-run the pure matcher with the freshly computed scores folded in.
      const finding = matcher(rule, { ...ctx, moderationScores: scores });
      return finding ? [finding] : [];
    },
  };
}

// --------------------------------------------------------------------------
// OpenAI moderation client — the real detector (omni-moderation-latest). Free and
// low-latency. The key is injected (never read here from a literal); the caller
// pulls it from the environment / a per-team secret. Not wired into the prod /v1
// path yet — that is the A0-lane gateway integration follow-up.
// --------------------------------------------------------------------------

export interface OpenAIModerationClientOptions {
  apiKey: string;
  model?: string; // default "omni-moderation-latest"
  baseUrl?: string; // default "https://api.openai.com/v1"
  fetchImpl?: typeof fetch; // injectable for tests
}

export class OpenAIModerationClient implements ModerationClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIModerationClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "omni-moderation-latest";
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async moderate(text: string): Promise<ModerationScores> {
    const res = await this.fetchImpl(`${this.baseUrl}/moderations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`moderation endpoint returned ${res.status}`);
    }
    const json = (await res.json()) as {
      results?: Array<{ category_scores?: Record<string, number> }>;
    };
    const scores = json.results?.[0]?.category_scores;
    if (!scores || typeof scores !== "object") {
      throw new Error("moderation response missing category_scores");
    }
    return scores;
  }
}

// Build the real client from the environment, or null when no key is configured
// (so the lane simply runs without the moderation detector until a key lands).
export function openAIModerationClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIModerationClient | null {
  const apiKey = env["OPENAI_API_KEY"] ?? env["OPENAI_MODERATION_KEY"];
  if (!apiKey) return null;
  return new OpenAIModerationClient({ apiKey });
}

// --------------------------------------------------------------------------
// Heuristic (offline) client — a dependency-free lexical baseline. Weighted
// category lexicons produce a 0..1 score from raw text, so the whole G3 path is
// demoable and testable with no network and no key. Deliberately conservative on
// benign text (low false-positive is acceptance-#2). NOT production accuracy.
// --------------------------------------------------------------------------

// Category -> indicative terms. Kept intentionally mild (no slurs / graphic
// strings in the repo) — each term is a category *signal*, not an exhaustive
// lexicon; the real provider does the heavy lifting.
const HEURISTIC_LEXICON: Record<string, string[]> = {
  hate: ["hate", "inferior race", "subhuman", "should not exist", "ethnic"],
  "hate/threatening": ["exterminate", "wipe out your kind", "gas them"],
  harassment: ["idiot", "loser", "pathetic", "worthless", "shut up stupid"],
  "harassment/threatening": ["i will find you", "watch your back", "you will regret"],
  "self-harm": ["kill myself", "end my life", "self harm", "hurt myself", "want to die"],
  "self-harm/intent": ["tonight i will end it", "planning to kill myself"],
  sexual: ["explicit sexual", "graphic sex", "nsfw", "porn"],
  "sexual/minors": ["underage", "child sexual", "minor explicit"],
  violence: ["kill him", "shoot them", "stab", "beat him up", "attack them"],
  "violence/graphic": ["dismember", "gore", "mutilate", "decapitate"],
  illicit: ["how to make a bomb", "buy illegal drugs", "steal a car", "counterfeit money"],
  "illicit/violent": ["build a weapon to hurt", "how to poison someone"],
};

export interface HeuristicModerationClientOptions {
  // Score assigned when a category term is present. Deterministic; a single hit is
  // already a strong signal for these phrase-level terms. Default 0.9.
  hitScore?: number;
}

export class HeuristicModerationClient implements ModerationClient {
  private readonly hitScore: number;

  constructor(opts: HeuristicModerationClientOptions = {}) {
    this.hitScore = opts.hitScore ?? 0.9;
  }

  async moderate(text: string): Promise<ModerationScores> {
    const hay = text.toLowerCase();
    const scores: ModerationScores = {};
    for (const [category, terms] of Object.entries(HEURISTIC_LEXICON)) {
      let best = 0;
      for (const term of terms) {
        if (hay.includes(term)) best = Math.max(best, this.hitScore);
      }
      scores[category] = best;
    }
    return scores;
  }
}

// Re-export the default category set for callers that build a custom rule config.
export { DEFAULT_MODERATION_CATEGORIES };
