// Groundedness / faithfulness judge (ELEAA-790 / G2).
//
// A judge answers one RAG question: "did this response stay faithful to the
// retrieved context?" It returns a 0..1 score and the specific response spans it
// could not support. The pure guardrail matcher (rules.ts) consumes only the
// *score* off GuardrailContext — exactly as the runaway-loop matcher consumes a
// repeatCount computed by an impure caller — so the engine stays deterministic.
// The judge itself is the impure part; it runs in the A0 async signal lane.
//
// This module ships the SEAM plus a dependency-free lexical baseline, and the
// A0-lane detector that runs the judge and folds its score into the pure matcher:
//   - `GroundednessJudge` is the contract the A0 model judge implements. Swapping
//     a stronger NLI/faithfulness model in is a one-line replacement at the call
//     site — no engine or type change.
//   - `lexicalGroundednessJudge` is a real, deterministic v0: claim-coverage over
//     the source. It is weaker than an NLI model (it will not clear the ELEAA-790
//     acceptance-#1 precision/recall bar on its own — that needs A0's model), but
//     it makes the whole path demoable and testable today, and it never calls out.
//   - `makeGroundednessDetector` is the SignalDetector the A0 lane runs: it calls
//     the judge on the response, then hands the score to the pure matcher so the
//     verdict/threshold logic stays in one place (rules.ts, matchGroundedness).

import { MATCHERS } from "./rules.js";
import type { SignalDetector } from "./signal-lane.js";
import type {
  GuardrailContext,
  GuardrailFinding,
  GuardrailRule,
} from "./types.js";

export interface GroundednessResult {
  // Fraction (0..1) of the response's claims supported by the source context.
  // 1 = fully grounded, 0 = nothing supported.
  score: number;
  // The offending response spans (claims) the judge could not find support for.
  // These become the rule's evidence, so they are kept short and are redacted of
  // secrets/PII by the matcher before they are attached.
  unsupportedClaims: string[];
}

// The contract A0's model judge implements. May be sync (the lexical baseline) or
// async (a model call). Must never throw — the async lane fails open, so a judge
// that errors should be caught by its caller and treated as "did not run".
export type GroundednessJudge = (
  response: string,
  source: string | string[],
) => GroundednessResult | Promise<GroundednessResult>;

// Normalize the source (string | string[]) into one searchable blob.
function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("\n") : source;
}

// Split text into claim-sized units (sentences). Kept deliberately simple: split
// on sentence terminators and newlines, drop empties. A claim is the span we test
// for support and, if unsupported, surface as evidence.
export function splitClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Content tokens (lowercased word stems), stopwords removed so shared filler
// ("the", "is", "a") never counts as support. Numbers are kept — a wrong figure
// is the classic RAG hallucination we most want to catch.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "as", "at", "by", "it",
  "this", "that", "these", "those", "from", "into", "than", "then", "so", "such",
  "will", "would", "can", "could", "may", "might", "has", "have", "had", "do",
  "does", "did", "not", "no", "yes", "if", "your", "you", "our", "we", "they",
]);

function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

// A claim is "supported" when a high fraction of its content tokens appear in the
// source. This is coverage/containment, not semantic entailment — cheap, and it
// reliably catches the fabricated-detail failure mode (a name, number, or fact
// that simply is not in the retrieved context). The threshold is per-claim; the
// rule-level threshold in config governs the overall score.
const PER_CLAIM_SUPPORT = 0.6;

// Numbers and capitalized entities in the claim. These are the specifics a RAG
// answer most often gets wrong ("330m" -> "500m", "Paris" -> "Berlin") while
// every surrounding word still matches the source, so token coverage alone would
// wave them through. We require each to appear in the source; an unmatched one is
// a hard mismatch — the answer asserts a specific the context does not support.
function numbers(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}
// Proper-noun-ish tokens: capitalized words that are not at a sentence start (a
// sentence-initial capital is just grammar). Deliberately conservative to keep
// false positives down — this is a v0 baseline, not the A0 model.
function properNouns(text: string): string[] {
  const out: string[] = [];
  const re = /(\S)\s+([A-Z][a-z]{2,})/g; // a capitalized word preceded by a token
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!STOPWORDS.has(m[2]!.toLowerCase())) out.push(m[2]!.toLowerCase());
  }
  return out;
}

function claimSupport(
  claim: string,
  sourceTokenSet: Set<string>,
  sourceNumbers: Set<string>,
): number {
  const tokens = contentTokens(claim);
  if (tokens.length === 0) return 1; // nothing substantive to contradict

  // Hard mismatch: a number or named entity the source never mentions.
  if (numbers(claim).some((n) => !sourceNumbers.has(n))) return 0;
  if (properNouns(claim).some((p) => !sourceTokenSet.has(p))) return 0;

  const hits = tokens.filter((t) => sourceTokenSet.has(t)).length;
  return hits / tokens.length;
}

// Dependency-free baseline judge (v0). Deterministic, pure, and synchronous — a
// concrete GroundednessResult return (not the judge union) so callers can read
// .score directly. Still structurally assignable to GroundednessJudge.
export function lexicalGroundednessJudge(
  response: string,
  source: string | string[],
): GroundednessResult {
  const src = joinSource(source);
  const sourceTokenSet = new Set(contentTokens(src));
  const sourceNumbers = new Set(numbers(src));
  const claims = splitClaims(response);
  if (claims.length === 0) return { score: 1, unsupportedClaims: [] };

  const unsupported: string[] = [];
  let supported = 0;
  for (const claim of claims) {
    if (claimSupport(claim, sourceTokenSet, sourceNumbers) >= PER_CLAIM_SUPPORT) {
      supported += 1;
    } else {
      unsupported.push(claim);
    }
  }
  return { score: supported / claims.length, unsupportedClaims: unsupported };
}

// Run a judge safely (fail-open): any throw or rejection resolves to null so the
// caller treats it as "the detector did not run" and leaves the rule inert,
// matching the A0 async-lane contract. This is the one helper the impure caller
// (gateway / A0 lane) uses; the engine never touches it.
export async function runGroundednessJudge(
  judge: GroundednessJudge,
  response: string | undefined,
  source: string | string[] | undefined,
): Promise<GroundednessResult | null> {
  if (!response || source == null) return null;
  const src = Array.isArray(source) ? source : [source];
  if (src.every((s) => !s || !s.trim())) return null; // no real source → inert
  try {
    const result = await judge(response, source);
    if (!result || typeof result.score !== "number" || !Number.isFinite(result.score)) {
      return null;
    }
    return {
      score: Math.max(0, Math.min(1, result.score)),
      unsupportedClaims: Array.isArray(result.unsupportedClaims)
        ? result.unsupportedClaims
        : [],
    };
  } catch {
    return null; // fail open
  }
}

// --------------------------------------------------------------------------
// Detector — the SignalDetector the A0 lane runs for the `groundedness` rule.
// This is the piece that DEPENDS ON A0 (ELEAA-787): it is the impure counterpart
// of matchGroundedness. It runs only on response egress (a request has no answer
// to judge), calls the judge on the answer vs. its source context, then re-runs
// the pure matcher with the freshly computed score folded in — so thresholding,
// evidence, redaction and the requireSourceContext behaviour all stay in one
// place (rules.ts). It never throws: the judge is wrapped fail-open, and a null
// result leaves ctx untouched so the matcher stays inert (matching the lane's
// fail-open contract).
//
// Swap the model in by passing an NLI/faithfulness `GroundednessJudge` here; the
// lexical baseline is the zero-dependency default for demos and offline tests.
export function makeGroundednessDetector(
  judge: GroundednessJudge = lexicalGroundednessJudge,
): SignalDetector {
  return {
    type: "groundedness",
    async detect(rule: GuardrailRule, ctx: GuardrailContext): Promise<GuardrailFinding[]> {
      // Only the response side has an answer to judge. Skipping here avoids a
      // wasted judge call; the matcher also gates on direction, so this is belt
      // and suspenders.
      if (ctx.direction !== "response") return [];
      const matcher = MATCHERS.groundedness;
      if (!matcher) return [];

      // Run the judge fail-open. null = "did not run" (no source, empty source,
      // or the model errored) — fold nothing so the matcher stays inert, except
      // that requireSourceContext can still fire on a missing-context response.
      const judged = await runGroundednessJudge(judge, ctx.content, ctx.sourceContext);
      const merged: GuardrailContext = judged
        ? {
            ...ctx,
            groundednessScore: judged.score,
            unsupportedClaims: judged.unsupportedClaims,
          }
        : ctx;

      const found = matcher(rule, merged);
      return found ? [found] : [];
    },
  };
}
