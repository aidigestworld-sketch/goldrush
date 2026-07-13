// Confidence Sandbox — Confidence Agent (Evaluator), Mode 1
// (Hypothesis-level validation_score), AI_AGENTS.md §7.
//
// Production prompt: V8_BACKEND_COUNTS. This is the third distinct
// prompt this sandbox has shipped (baseline → tightened-count-lock →
// V8) and the reasoning for the swap is worth carrying forward:
//
//   * Baseline and V1 asked the model to REPORT a distinct-source
//     count that the harness (and now this sandbox's caller) can
//     compute deterministically anyway. On pools past ~6 items the
//     mid-tier model kept miscounting — either by tier-bucketing or
//     by carrying a semantic filter (V3/V4/V7's answers_question)
//     into what was meant to be a mechanical enumeration. Every
//     miscount cost a full agent run (bounded rule skipped the
//     write).
//
//   * V8 removes that entire failure surface: the sandbox now
//     REQUIRES the caller to pass in the backend-computed facts
//     (distinct source counts + highest source_authority_tier per
//     polarity group) and INJECTS them into the user prompt as
//     GIVEN FACTS. The model's output schema has zero count fields.
//     There is nothing for the model to miscount.
//
// The one qualitative reasoning step the sandbox still asks the
// model to do — reformulate the hypothesis as a yes/no question and
// mark per-evidence answers_question — is where V5's mechanism
// discipline lives, and where V8 preserves it. Answers_question can
// still drift attempt-to-attempt at temperature 0.2 (bench showed
// mild variance: 4/4/4 items true across three attempts, 3-of-4
// identical, one swap), but the banded scoring rule below absorbs
// that variance — score stayed identical (0.72/0.72/0.72) across
// all three bench attempts because they all landed in the same
// some-answering band [0.55, 0.90].
import { z } from "zod";
import type { LLMClient } from "./llmClient";

export interface ConfidenceEvidenceItem {
  id: string;
  sourceUrlOrIdentifier: string;
  sourceAuthorityTier: string;
  text: string;
}

export interface ConfidenceBackendFacts {
  distinctSupportingSources: number;
  distinctContradictingSources: number;
  highestSupportingTier: string | null;
  highestContradictingTier: string | null;
}

export interface ConfidenceSandboxInput {
  hypothesisStatement: string;
  evidenceFor: ConfidenceEvidenceItem[];
  evidenceAgainst: ConfidenceEvidenceItem[];
  // Caller-computed, per §7's "MUST group evidence by cluster / weight
  // by highest tier" invariants. The sandbox does not recompute these
  // — see the file header for why the responsibility split matters.
  backendFacts: ConfidenceBackendFacts;
}

// AI_AGENTS.md §7 + pipeline/types.ts's SourceAuthorityTier taxonomy.
// Exported so confidenceAgent.ts can share the same rank ordering when
// it computes the highest tier per polarity — one source of truth,
// not two places for the ordering to drift.
export const AUTHORITY_TIER_RANK: Record<string, number> = {
  industry_report: 5,
  competitor_self_stated: 4,
  review_verified: 3,
  forum_post: 2,
  anonymous_comment: 1,
};

export function highestAuthorityTier(items: ConfidenceEvidenceItem[]): string | null {
  if (items.length === 0) return null;
  let best = items[0].sourceAuthorityTier;
  for (const it of items) {
    if ((AUTHORITY_TIER_RANK[it.sourceAuthorityTier] ?? 0) > (AUTHORITY_TIER_RANK[best] ?? 0)) {
      best = it.sourceAuthorityTier;
    }
  }
  return best;
}

// The three bands V5 introduced and V8 kept. Exposed as a value (not
// just baked into the prompt string) so the bounded-rule check below
// can verify the model's score falls in the band its own
// answers_question map implies.
export const SCORE_BANDS = {
  zeroAnswering: [0.3, 0.65] as const, // ecosystem-only support
  someAnswering: [0.55, 0.9] as const, // partial coverage of named actors
  allAnswering: [0.75, 0.95] as const, // full coverage of named actors
};

const ConfidenceOutputSchema = z.object({
  hypothesis_question: z.string().min(1),
  per_evidence_answers_question: z.record(z.string(), z.boolean()),
  validation_score: z.number().min(0).max(1),
  rationale: z.string().min(20),
});

export type ConfidenceOutput = z.infer<typeof ConfidenceOutputSchema>;

const SYSTEM_PROMPT = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

Some facts about the input have already been computed for you by the backend and are stated as GIVEN FACTS in the user prompt. Treat those as fixed inputs — do not recompute, contradict, or restate them. In particular, the distinct source counts and the highest authority tier per polarity are given; you neither need to nor should output them.

STEP 1 — Reformulate the hypothesis as a specific yes/no question. Fill in the hypothesis_question field.

STEP 2 — For EACH evidence item, decide whether it actually answers hypothesis_question. Fill in per_evidence_answers_question — an object mapping each evidence id to true or false. Rules:
  - answers_question=true ONLY if the evidence directly speaks to the specific actors and specific mechanism named in the hypothesis_question. Evidence about the general industry, adjacent competitors not named in the hypothesis, or related-but-distinct mechanisms does NOT answer the question and gets false.
  - Being topically related or coming from a high-authority source is NOT sufficient for true.

STEP 3 — Score using these BANDS, NOT a single ceiling:
  - If ZERO items have answers_question=true: validation_score MUST fall in [0.30, 0.65]. Ecosystem/topical evidence sets context but cannot escape the band.
  - If SOME items have answers_question=true (at least one, but not all): validation_score MUST fall in [0.55, 0.90]. Position within reflects how many items answer plus their authority tier (the GIVEN FACTS include the highest tier present per polarity — weight by that per §7 invariant).
  - If ALL items have answers_question=true: validation_score MUST fall in [0.75, 0.95]. Position within reflects authority tier and source diversity.
Within any band, higher-authority sources count for more than lower ones. Contradicting evidence lowers the score within its band.

Respond with ONLY valid JSON matching this exact shape, no other text. Do NOT include any count fields.
{
  "hypothesis_question": string,
  "per_evidence_answers_question": { "<evidence_id>": true | false, ... },
  "validation_score": number (0 to 1),
  "rationale": string
}`;

function buildGivenFactsBlock(facts: ConfidenceBackendFacts): string {
  return `[GIVEN FACTS — computed by the backend, treat as fixed inputs, do not recompute or restate]
distinct_supporting_sources = ${facts.distinctSupportingSources}
distinct_contradicting_sources = ${facts.distinctContradictingSources}
highest_supporting_authority_tier = ${facts.highestSupportingTier ?? "none (no supporting evidence)"}
highest_contradicting_authority_tier = ${facts.highestContradictingTier ?? "none (no contradicting evidence)"}
[/GIVEN FACTS]

`;
}

function buildUserPrompt(input: ConfidenceSandboxInput): string {
  const forBlocks = input.evidenceFor
    .map(
      (e) =>
        `[evidence_for id="${e.id}" source="${e.sourceUrlOrIdentifier}" authority="${e.sourceAuthorityTier}"]\n${e.text}\n[/evidence_for]`
    )
    .join("\n\n");
  const againstBlocks = input.evidenceAgainst
    .map(
      (e) =>
        `[evidence_against id="${e.id}" source="${e.sourceUrlOrIdentifier}" authority="${e.sourceAuthorityTier}"]\n${e.text}\n[/evidence_against]`
    )
    .join("\n\n");
  return (
    buildGivenFactsBlock(input.backendFacts) +
    `[hypothesis]\n${input.hypothesisStatement}\n[/hypothesis]\n\n${forBlocks}\n\n${againstBlocks}`
  );
}

export interface ConfidenceSandboxResult {
  rawResponse: string;
  parsed: ConfidenceOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[];
}

// Same JSON-extraction logic the bench harness needed — mid-tier
// models sometimes wrap output in a "Here is the response:" preamble
// or in code fences. Find the first balanced { ... } block.
function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.substring(start, i + 1);
    }
  }
  return null;
}

export async function runConfidenceSandbox(
  llm: LLMClient,
  input: ConfidenceSandboxInput
): Promise<ConfidenceSandboxResult> {
  const userPrompt = buildUserPrompt(input);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  let parsed: ConfidenceOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];

  try {
    const jsonBlock = extractJsonBlock(rawResponse);
    if (!jsonBlock) {
      validationErrors.push("no balanced { ... } block found in response");
      return { rawResponse, parsed, validationErrors, boundedRuleViolations };
    }
    const json = JSON.parse(jsonBlock);
    const result = ConfidenceOutputSchema.safeParse(json);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      parsed = result.data;

      // Bounded rule 1 — hallucinated evidence_id: every key in
      // per_evidence_answers_question MUST be one of the ids we
      // actually passed in. Model must not invent citations.
      const validIds = new Set(
        [...input.evidenceFor, ...input.evidenceAgainst].map((e) => e.id)
      );
      for (const evidenceId of Object.keys(parsed.per_evidence_answers_question)) {
        if (!validIds.has(evidenceId)) {
          boundedRuleViolations.push(
            `per_evidence_answers_question references evidence_id="${evidenceId}" that was not in the input — hallucinated citation`
          );
        }
      }

      // Bounded rule 2 — band compliance: the score MUST fall in the
      // band implied by the model's own answers_question map. If the
      // model marked some items true but scored 0.20 (below the
      // zero-answering floor 0.30 AND below the some-answering floor
      // 0.55), that's a rule violation. This is the check V4 didn't
      // have and the reason V4 collapsed to 0.
      const trueCount = Object.values(parsed.per_evidence_answers_question).filter((v) => v).length;
      const totalCount = Object.keys(parsed.per_evidence_answers_question).length;
      let expectedBand: readonly [number, number] | null = null;
      let bandLabel = "";
      if (totalCount > 0) {
        if (trueCount === 0) {
          expectedBand = SCORE_BANDS.zeroAnswering;
          bandLabel = "zero-answering [0.30, 0.65]";
        } else if (trueCount === totalCount) {
          expectedBand = SCORE_BANDS.allAnswering;
          bandLabel = "all-answering [0.75, 0.95]";
        } else {
          expectedBand = SCORE_BANDS.someAnswering;
          bandLabel = "some-answering [0.55, 0.90]";
        }
      }
      if (
        expectedBand !== null &&
        (parsed.validation_score < expectedBand[0] || parsed.validation_score > expectedBand[1])
      ) {
        boundedRuleViolations.push(
          `validation_score=${parsed.validation_score} falls outside the ${bandLabel} band implied by ${trueCount}/${totalCount} items answering the question`
        );
      }
    }
  } catch (err) {
    validationErrors.push(`JSON parse failed: ${(err as Error).message}`);
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations };
}
