// Prompt A/B harness for the Confidence Agent (Mode 1).
//
// Purpose: test candidate SYSTEM_PROMPT wordings against the SAME real
// graph input, without touching confidenceSandbox.ts's production
// prompt or committing anything to the DB. This exists because the
// mid-tier NIM (llama-3.3-nemotron-super-49b-v1) has shown a repeated
// pattern of scoring topically-aligned-but-mechanism-mismatched
// evidence too generously (0.85→0.92 on a hypothesis where 0.60–0.75
// is more defensible per the qualitative reads in prior run reports).
// Rather than blind-tune the production prompt, this script runs 4
// candidates side-by-side and prints their scores/rationales.
//
// Run: npx tsx -r dotenv/config src/scripts/experimentConfidencePrompts.ts <hypothesisId> [variant1,variant2,...]
//   variants default to all four; pass a comma-separated subset (e.g. "V1,V5") to run selectively.
//
// Reads: hypothesis, node_source_refs, evidence — same read path as
// confidenceAgent.ts, including polarity split.
// Writes: nothing. This is a scoring bench, not an agent run.
//
// =============================================================
// DECISION LOG — V5_HYBRID_BANDED is the reviewed candidate
// replacement for production, deliberately NOT deployed as of
// this file. Do not delete without reading this block first.
// =============================================================
//
// Bench summary (see prior run reports for full data):
//   * V1 (current production, shipped in confidenceSandbox.ts):
//     produces 0.85–0.92 on hypothesis 01c1110d-… with 4 supporting
//     evidence rows where none of the rows actually names Recharge,
//     Bold, or Loop directly. Model rewards topical/ecosystem
//     alignment as if it were mechanism-level support.
//   * V5_HYBRID_BANDED (in this file): forces the model to
//     reformulate the hypothesis as a question, mark each evidence
//     item's answers_question true/false, and score inside one of
//     three explicit bands ([0.30, 0.65] / [0.55, 0.90] / [0.75,
//     0.95]) driven by how many items answer the reformulated
//     question. On the same input V5 produces 0.35, and its
//     rationale correctly names the mechanism gap. Bounded rule
//     clean; count-vs-filter contamination that broke V3/V4 fixed.
//
// Why V5 is not deployed (READ THIS BEFORE PROPOSING TO SWAP IT IN):
//
// V5's [0.30, 0.65] "zero-answers" band would fail every currently-
// active hypothesis on Confidence Agent's next run, because
// Validation Collector's active-search side is STILL STUBBED (see
// validationSandbox.ts and validationAgent.ts's headers — "search
// over what's already ingested, not search the web"). No evidence
// row in the current corpus directly names Recharge/Bold/Loop's
// features on the mechanism the shopify_subscriptions hypotheses
// are about. So under V5, every hypothesis would land in the
// zero-answers band, score <= 0.65, and — with the current 0.5
// VALIDATION_GATE_THRESHOLD — get marked deprecated with reason
// 'failed_validation'. That failure would be attributable to a
// SYSTEM CAPABILITY GAP (no ability to fetch competitor-specific
// evidence), not to a genuine hypothesis-quality signal. Gating on
// V5 today would deprecate hypotheses for the wrong reason.
//
// Unblock condition:
//   Ship real active-search in Validation Collector — the "actively
//   query for disconfirming/mechanism-specific evidence" capability
//   flagged as HONEST-SCOPE-LIMITED in validationSandbox.ts's
//   header, and called out in AI_AGENTS.md §6's constraint that
//   Validation MUST actively query the Data Pipeline. Once real
//   sources that name specific competitors can enter node_source_refs,
//   V5's answers_question=true path becomes reachable and the bands
//   discriminate real hypothesis quality (not corpus reach).
//
// When that unblock lands, the swap-in path is: (a) copy
// V5_HYBRID_BANDED into confidenceSandbox.ts's SYSTEM_PROMPT,
// (b) update the schema and buildUserPrompt to emit the two extra
// fields (hypothesis_question, per_evidence_answers_question) and
// the renamed count fields (total_supporting_input_sources /
// total_contradicting_input_sources — different names on purpose,
// see V5's decoupling rationale), (c) re-run confidenceSandbox.test.ts
// with a fixture whose ground-truth answers_question is known,
// (d) re-run the live agent on a hypothesis with at least one
// mechanism-answering source in scope.
//
// Also mirrored, so it survives at the architecture-doc level and
// not just here: docs/AI_AGENTS.md §7's "known follow-ups" bullet
// list under the Confidence Agent contract.
import { z } from "zod";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import type { LLMClient } from "../sandbox/llmClient";
import { prisma } from "../db/client";

// Bench-local NIM client with a larger max_tokens ceiling than the
// production NimLLMClient (which hard-codes 2048). Reason this exists
// as a separate class rather than a NimLLMClient constructor
// parameter: this task is bench-only and the constraint "no production
// changes" applies to nimLLMClient.ts as much as it does to
// confidenceSandbox.ts's SYSTEM_PROMPT. V5's response schema
// (hypothesis_question + per_evidence_answers_question over N items +
// rationale + counts + score) exceeds 2048 tokens once N grows past
// ~6, so V4/V5 outputs get truncated mid-JSON on the enriched pool.
// This class is deliberately narrow: same endpoint, same auth, same
// temperature, only max_tokens differs.
class BenchNimClient implements LLMClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly maxTokens: number = 4096
  ) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: this.maxTokens,
      }),
    });
    if (!response.ok) throw new Error(`NIM API error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}

// Extract the first balanced JSON object from a response body. Handles
// preambles ("Here is the response in the requested format:") and
// wrapping code fences (```json ... ```) that mid-tier models add.
// Returns null if no plausible JSON block is found.
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

// Re-declaring the schema locally so we don't need to export it from
// confidenceSandbox.ts (keeping this bench file completely
// non-invasive on the production module).
//
// V1–V4 use distinct_supporting_source_count / distinct_contradicting_source_count.
// V5 renamed to total_supporting_input_sources / total_contradicting_input_sources.
// V6/V7 removed count fields entirely and require the model to emit
// supporting_source_urls / contradicting_source_urls arrays instead —
// the harness derives counts from the arrays' lengths. Schema below
// accepts all three shapes so one harness validates every variant.
// V1–V4 use distinct_*_source_count integers.
// V5 uses total_*_input_sources integers.
// V6/V7 use *_source_urls arrays and the harness derives counts from length.
// V8 doesn't have the model report counts at all — the backend computes
// them deterministically and injects them as GIVEN FACTS in the user
// prompt. Model output has NO count fields.
// Schema below accepts all four shapes with the refine relaxed; the
// runVariant call site pulls counts from whichever source applies
// (model-reported, array length, or backend-computed).
const ConfidenceOutputSchema = z.object({
  validation_score: z.number().min(0).max(1),
  distinct_supporting_source_count: z.number().int().min(0).optional(),
  distinct_contradicting_source_count: z.number().int().min(0).optional(),
  total_supporting_input_sources: z.number().int().min(0).optional(),
  total_contradicting_input_sources: z.number().int().min(0).optional(),
  supporting_source_urls: z.array(z.string()).optional(),
  contradicting_source_urls: z.array(z.string()).optional(),
  rationale: z.string().min(20),
});

interface EvidenceItem {
  id: string;
  sourceUrlOrIdentifier: string;
  sourceAuthorityTier: string;
  text: string;
}

// Authority tier ordering per pipeline/types.ts's SourceAuthorityTier
// enum (industry_report highest, anonymous_comment lowest). Deterministic
// backend rank lookup used by V8's GIVEN FACTS block.
const AUTHORITY_RANK: Record<string, number> = {
  industry_report: 5,
  competitor_self_stated: 4,
  review_verified: 3,
  forum_post: 2,
  anonymous_comment: 1,
};

function highestAuthorityTier(items: EvidenceItem[]): string | null {
  if (items.length === 0) return null;
  let best = items[0].sourceAuthorityTier;
  for (const it of items) {
    if ((AUTHORITY_RANK[it.sourceAuthorityTier] ?? 0) > (AUTHORITY_RANK[best] ?? 0)) {
      best = it.sourceAuthorityTier;
    }
  }
  return best;
}

interface BackendComputedFacts {
  distinctSupportingSources: number;
  distinctContradictingSources: number;
  highestSupportingTier: string | null;
  highestContradictingTier: string | null;
}

function computeBackendFacts(evidenceFor: EvidenceItem[], evidenceAgainst: EvidenceItem[]): BackendComputedFacts {
  return {
    distinctSupportingSources: new Set(evidenceFor.map((e) => e.sourceUrlOrIdentifier)).size,
    distinctContradictingSources: new Set(evidenceAgainst.map((e) => e.sourceUrlOrIdentifier)).size,
    highestSupportingTier: highestAuthorityTier(evidenceFor),
    highestContradictingTier: highestAuthorityTier(evidenceAgainst),
  };
}

function buildGivenFactsBlock(facts: BackendComputedFacts): string {
  return `[GIVEN FACTS — computed by the backend, treat as fixed inputs, do not recompute or restate]
distinct_supporting_sources = ${facts.distinctSupportingSources}
distinct_contradicting_sources = ${facts.distinctContradictingSources}
highest_supporting_authority_tier = ${facts.highestSupportingTier ?? "none (no supporting evidence)"}
highest_contradicting_authority_tier = ${facts.highestContradictingTier ?? "none (no contradicting evidence)"}
[/GIVEN FACTS]

`;
}

function buildUserPrompt(hypothesisStatement: string, evidenceFor: EvidenceItem[], evidenceAgainst: EvidenceItem[]): string {
  const forBlocks = evidenceFor
    .map(
      (e) =>
        `[evidence_for id="${e.id}" source="${e.sourceUrlOrIdentifier}" authority="${e.sourceAuthorityTier}"]\n${e.text}\n[/evidence_for]`
    )
    .join("\n\n");
  const againstBlocks = evidenceAgainst
    .map(
      (e) =>
        `[evidence_against id="${e.id}" source="${e.sourceUrlOrIdentifier}" authority="${e.sourceAuthorityTier}"]\n${e.text}\n[/evidence_against]`
    )
    .join("\n\n");
  return `[hypothesis]\n${hypothesisStatement}\n[/hypothesis]\n\n${forBlocks}\n\n${againstBlocks}`;
}

// =============================================================
// Variant 1 — BASELINE (verbatim copy of production SYSTEM_PROMPT
// as of the latest commit to confidenceSandbox.ts). Kept here as a
// literal snapshot so score drift is attributable to the variant
// changes, not to accidental drift from a prompt edit elsewhere.
// =============================================================
const V1_BASELINE = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

The single most important rule: evidence that traces back to the SAME underlying source (same source_url_or_identifier, e.g. two different quotes from one article) is NOT two independent confirmations — it's one. If you count the same source twice as if it were two independent pieces of corroboration, you are overstating confidence.

DEFINITION OF "distinct source" — this is mechanical, not interpretive: a distinct source is a unique source_url_or_identifier string among the inputs I pass you. Nothing else. Do NOT count by authority tier ("industry_report", "forum_post", etc.), source type, publisher, brand, topic cluster, or any other grouping. Two items with different source_url_or_identifier values are two distinct sources even if they share an authority tier or refer to the same underlying company or topic. Two items with the same source_url_or_identifier value are one distinct source even if they are different paragraphs or quotes. Count strings, not concepts.

To report distinct_supporting_source_count: collect every source_url_or_identifier value across all evidence_for items, deduplicate that list, and report its size. Same procedure for distinct_contradicting_source_count over evidence_against. If evidence_for has four items with four different source_url_or_identifier strings, the count is 4 — even if two of them share an authority tier, even if three of them are from the same publisher's website, even if all four discuss the same underlying topic.

Weight evidence from higher-authority sources (industry_report, competitor_self_stated) more than lower-authority ones (forum_post, anonymous_comment) when computing validation_score — but that weighting affects the score, NOT the distinct-source count. The count is purely a mechanical URL-deduplication tally.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "validation_score": number (0 to 1),
  "distinct_supporting_source_count": integer,
  "distinct_contradicting_source_count": integer,
  "rationale": string
}`;

// =============================================================
// Variant 2 — MECHANISM-SPECIFICITY INSTRUCTION.
// Adds an explicit paragraph telling the model to penalize
// ecosystem/topical evidence relative to mechanism-level evidence.
// Keeps every other rule identical to baseline.
// =============================================================
const V2_MECHANISM_INSTRUCTION = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

The single most important rule: evidence that traces back to the SAME underlying source (same source_url_or_identifier, e.g. two different quotes from one article) is NOT two independent confirmations — it's one. If you count the same source twice as if it were two independent pieces of corroboration, you are overstating confidence.

MECHANISM SPECIFICITY — this affects the score: evidence that describes the general ecosystem, industry trends, adjacent problems, or a related-but-distinct mechanism should be scored LOWER than evidence that directly describes the specific mechanism named in the hypothesis (for example, a named competitor's actual feature, actual behavior, or actual product limitation). Topical alignment is NOT equivalent to mechanism-level support. If the hypothesis names specific actors (e.g. specific competitors, a specific product behavior), evidence that does not directly describe those actors' actual state on that specific point is INDIRECT and must be penalized in the score — even if it is high-authority, even if there are many such items. Do not let source diversity or authority tier mask an absence of direct mechanism-level evidence.

DEFINITION OF "distinct source" — this is mechanical, not interpretive: a distinct source is a unique source_url_or_identifier string among the inputs I pass you. Nothing else. Do NOT count by authority tier ("industry_report", "forum_post", etc.), source type, publisher, brand, topic cluster, or any other grouping. Two items with different source_url_or_identifier values are two distinct sources even if they share an authority tier or refer to the same underlying company or topic. Two items with the same source_url_or_identifier value are one distinct source even if they are different paragraphs or quotes. Count strings, not concepts.

To report distinct_supporting_source_count: collect every source_url_or_identifier value across all evidence_for items, deduplicate that list, and report its size. Same procedure for distinct_contradicting_source_count over evidence_against.

Weight evidence from higher-authority sources (industry_report, competitor_self_stated) more than lower-authority ones (forum_post, anonymous_comment) when computing validation_score — but that weighting affects the score, NOT the distinct-source count. The count is purely a mechanical URL-deduplication tally.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "validation_score": number (0 to 1),
  "distinct_supporting_source_count": integer,
  "distinct_contradicting_source_count": integer,
  "rationale": string
}`;

// =============================================================
// Variant 3 — STRUCTURED INTERMEDIATE CLASSIFICATION.
// Requires the model to classify each evidence row as
// "direct_mechanism" | "indirect_ecosystem" | "adjacent" in a
// structured field before producing the final score, so the
// distinction is forced into its reasoning trace rather than left
// implicit. Also expands the response schema to include
// per_evidence_classification.
// =============================================================
const V3_STRUCTURED_CLASSIFICATION = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

The single most important rule: evidence that traces back to the SAME underlying source (same source_url_or_identifier, e.g. two different quotes from one article) is NOT two independent confirmations — it's one. If you count the same source twice as if it were two independent pieces of corroboration, you are overstating confidence.

BEFORE producing the score, classify EACH evidence item into exactly one of three categories:
  - "direct_mechanism": the evidence directly describes the specific mechanism, actor, or behavior named in the hypothesis. If the hypothesis claims "Competitor X does not do M", direct_mechanism evidence must actually be about Competitor X's actual behavior on M.
  - "indirect_ecosystem": the evidence describes the surrounding ecosystem, industry, or platform (e.g. Shopify itself, industry-wide statistics, a related bug in an unrelated actor). It sets context but does not confirm or deny the specific mechanism claim.
  - "adjacent": the evidence describes a related-but-distinct mechanism (e.g. a different type of churn, a different competitor, a different product feature).

Include per_evidence_classification in your response — an object mapping each evidence id to its category.

When computing validation_score, weight direct_mechanism evidence significantly more heavily than indirect_ecosystem or adjacent evidence. A hypothesis supported ONLY by indirect_ecosystem/adjacent evidence — no matter how many high-authority sources — should not exceed 0.7. A hypothesis supported by multiple direct_mechanism sources can reach 0.9+. This scoring floor exists to prevent topical alignment from masquerading as mechanism-level confirmation.

DEFINITION OF "distinct source" — this is mechanical, not interpretive: a distinct source is a unique source_url_or_identifier string among the inputs I pass you. Nothing else. Do NOT count by authority tier or any other grouping. Two items with different source_url_or_identifier values are two distinct sources. Two items with the same source_url_or_identifier value are one distinct source. Count strings, not concepts.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "per_evidence_classification": { "<evidence_id>": "direct_mechanism" | "indirect_ecosystem" | "adjacent", ... },
  "validation_score": number (0 to 1),
  "distinct_supporting_source_count": integer,
  "distinct_contradicting_source_count": integer,
  "rationale": string
}`;

// =============================================================
// Variant 4 — MY VARIANT: "ANSWER-THE-QUESTION" TEST.
// Reasoning: variants 2 and 3 tell the model what NOT to do
// (don't over-weight ecosystem evidence). This variant instead
// gives it a concrete SELF-CHECK to run: "reconstruct the exact
// question the hypothesis asks, then check whether each piece of
// evidence actually answers it." This is more mechanical than
// "penalize topical evidence" (vague) and doesn't require the
// model to correctly classify categories (variant 3's failure
// mode: mislabeling ecosystem as direct_mechanism). Instead the
// model must produce a hypothesis_question field that a reviewer
// can inspect, and then a per-evidence "answers_question"
// boolean. If no evidence has answers_question=true, the score
// must be capped at 0.65 explicitly. This makes the reasoning
// auditable — you can see WHICH question the model thought it
// was scoring against.
// =============================================================
const V4_ANSWER_THE_QUESTION = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

STEP 1 — Reformulate the hypothesis as a specific yes/no question. Fill in the hypothesis_question field with that reformulation. Example: hypothesis "Competitor X does not offer feature F" reformulates to "Does Competitor X offer feature F?".

STEP 2 — For EACH evidence item, decide whether it actually answers hypothesis_question. Fill in the per_evidence_answers_question field — an object mapping each evidence id to true or false. Rules:
  - answers_question=true ONLY if the evidence directly speaks to the specific actors and specific mechanism named in the hypothesis_question. Evidence about the general industry, adjacent competitors not named in the hypothesis, or related-but-distinct mechanisms does NOT answer the question and gets false.
  - Being topically related or coming from a high-authority source is NOT sufficient to set answers_question=true. The evidence must directly address the specific actors and mechanism.

STEP 3 — Score with this constraint: if per_evidence_answers_question has no true values, validation_score MUST NOT exceed 0.65 no matter how many diverse or high-authority sources exist. Ecosystem evidence sets confidence context but cannot alone confirm a hypothesis about specific actors' behavior. If at least one item answers the question, higher scores become available; more items answering directly raise the ceiling further.

The single most important rule ON SOURCE COUNTING: evidence that traces back to the SAME underlying source (same source_url_or_identifier) is NOT two independent confirmations — it's one. DEFINITION OF "distinct source" is mechanical: a distinct source is a unique source_url_or_identifier string. Do NOT count by authority tier, source type, publisher, brand, or topic. Two items with different source_url_or_identifier values are two distinct sources. Two items with the same source_url_or_identifier value are one distinct source. Count strings, not concepts.

Weight evidence from higher-authority sources more than lower-authority ones when computing validation_score — but authority weighting only applies to items where answers_question=true. High-authority ecosystem evidence still cannot exceed the 0.65 ceiling.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "hypothesis_question": string,
  "per_evidence_answers_question": { "<evidence_id>": true | false, ... },
  "validation_score": number (0 to 1),
  "distinct_supporting_source_count": integer,
  "distinct_contradicting_source_count": integer,
  "rationale": string
}`;

// =============================================================
// Variant 5 — HYBRID (V4's reasoning structure, without V4's failure modes).
//
// Origin: reading V1–V4's results side-by-side, V4's qualitative
// reasoning was the sharpest (correctly reformulated the question,
// correctly marked all 4 items as failing to answer it), but V4 had
// two mechanical failures — score collapsed to 0 instead of the
// intended ceiling, and the distinct-source count contaminated with
// the answers_question filter (dropped to 0). V5 fixes both:
//   (a) The count field is renamed to total_supporting_input_sources
//       with the mechanical URL-dedup instruction placed INLINE
//       adjacent to the field definition, not paragraphs upstream —
//       this is the "repeat the instruction next to the field name"
//       lever, which is a well-known fix for the "model applies
//       filter A to field B" contamination we saw in V3/V4.
//   (b) A single "MUST NOT exceed 0.65" ceiling gets replaced with
//       three explicit bands (0-answers → [0.30, 0.65], some → [0.55,
//       0.90], all → [0.75, 0.95]) — the band form gives the model
//       room to still weight authority tier within a defensible
//       range instead of collapsing to a corner.
// =============================================================
const V5_HYBRID_BANDED = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

STEP 1 — Reformulate the hypothesis as a specific yes/no question. Fill in the hypothesis_question field with that reformulation. Example: hypothesis "Competitor X does not offer feature F" reformulates to "Does Competitor X offer feature F?".

STEP 2 — For EACH evidence item, decide whether it actually answers hypothesis_question. Fill in the per_evidence_answers_question field — an object mapping each evidence id to true or false. Rules:
  - answers_question=true ONLY if the evidence directly speaks to the specific actors and specific mechanism named in the hypothesis_question. Evidence about the general industry, adjacent competitors not named in the hypothesis, or related-but-distinct mechanisms does NOT answer the question and gets false.
  - Being topically related or coming from a high-authority source is NOT sufficient to set answers_question=true. The evidence must directly address the specific actors and mechanism.

STEP 3 — Score using these BANDS, NOT a single ceiling:
  - If ZERO items have answers_question=true: validation_score MUST fall in the closed interval [0.30, 0.65]. Ecosystem/topical evidence sets context (raising within the band by source diversity and authority) but cannot escape it — a hypothesis about specific actors' behavior cannot be confirmed by evidence that never describes those actors.
  - If SOME items have answers_question=true (at least one, but not all): validation_score MUST fall in [0.55, 0.90]. Position within the band reflects how many items answer plus their authority tier.
  - If ALL items have answers_question=true: validation_score MUST fall in [0.75, 0.95]. Position within the band reflects authority tier and source diversity.
  Within any band, weight higher-authority sources (industry_report, competitor_self_stated) more than lower-authority ones (forum_post, anonymous_comment). Contradicting evidence lowers the score within its applicable band; if it dominates, the applicable band is the "zero-answering" one.

STEP 4 — Count sources MECHANICALLY. This step is independent of Step 2's answers_question filter.
  total_supporting_input_sources = the number of DISTINCT source_url_or_identifier strings across ALL items in evidence_for, deduplicated. Count every item in evidence_for regardless of its answers_question value — this is a RAW COUNT of input source URLs, not a filtered count. If evidence_for has four items with four different source_url_or_identifier strings, total_supporting_input_sources is 4 — even if zero of them have answers_question=true.
  total_contradicting_input_sources = the same mechanical dedup, applied to evidence_against.
  Do NOT filter these counts by answers_question, category, authority tier, publisher, brand, or topic. Count unique URL strings, nothing else.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "hypothesis_question": string,
  "per_evidence_answers_question": { "<evidence_id>": true | false, ... },
  "validation_score": number (0 to 1),
  "total_supporting_input_sources": integer,
  "total_contradicting_input_sources": integer,
  "rationale": string
}`;

// =============================================================
// Variant 6 — V1 baseline + explicit URL-enumeration count-lock.
//
// Motivation: on the 10-item Tavily-enriched pool, both V1 and V5
// miscounted distinct_supporting_source_count (V1: 6 vs 8, V5: 7 vs
// 8) — the mid-tier model isn't reliable at counting past ~6 items
// under either prompt. Both hit the bounded rule.
//
// This variant tests a mechanical fix borrowed from V5's decoupling
// lesson: instead of asking the model to REPORT an integer count
// (which it estimates or bucket-guesses at scale), require it to
// EMIT the underlying list of source_url_or_identifier strings, and
// let the harness derive the count from the array's length. The
// model can no longer miscount because the count isn't its output —
// it's a function of what it output.
//
// The schema deliberately does NOT include a count integer field;
// including one alongside the array would give the model two
// opportunities to disagree with itself, and V3/V4 already showed
// that when a semantic classification sits next to a mechanical
// count, the count picks up the classification's contamination.
// Only the arrays are in the schema; the harness computes counts.
// =============================================================
const V6_COUNT_LOCK = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

The single most important rule: evidence that traces back to the SAME underlying source (same source_url_or_identifier, e.g. two different quotes from one article) is NOT two independent confirmations — it's one. If you count the same source twice as if it were two independent pieces of corroboration, you are overstating confidence.

STEP A — ENUMERATE the source URLs before any other reasoning. Do NOT skip this step, do NOT estimate, do NOT summarize. Produce two exhaustive lists:
  supporting_source_urls: an array of every distinct source_url_or_identifier string that appears on ANY [evidence_for] block in the input. Deduplicate exact string matches, then include one entry per distinct URL. Order does not matter. Do NOT filter by authority tier, topic, or your assessment of relevance — include EVERY distinct source_url_or_identifier from evidence_for.
  contradicting_source_urls: same procedure, over [evidence_against] blocks.
The count IS the length of these arrays — the harness reads it that way. Do not report a separate count integer. If you produce short arrays because you "know the count," that is the miscounting failure this rule exists to prevent.

STEP B — compute validation_score using the source lists you just enumerated. Weight higher-authority sources (industry_report, competitor_self_stated) more than lower-authority ones (forum_post, anonymous_comment). Contradicting evidence lowers the score in proportion to its authority-weighted magnitude relative to supporting evidence.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "supporting_source_urls": string[],
  "contradicting_source_urls": string[],
  "validation_score": number (0 to 1),
  "rationale": string
}`;

// =============================================================
// Variant 7 — V5 hybrid + the same URL-enumeration count-lock.
//
// Contingent: only worth running if V6 shows the count-lock
// mechanic actually reliably fixes the count at scale. Same schema
// change (supporting_source_urls/contradicting_source_urls arrays
// replace the count integers), plus V5's hypothesis_question and
// per_evidence_answers_question and banded score.
// =============================================================
const V7_V5_COUNT_LOCK = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and its supporting/contradicting evidence, compute a validation_score (0 to 1) reflecting how well-supported the hypothesis actually is.

STEP 1 — Reformulate the hypothesis as a specific yes/no question. Fill in the hypothesis_question field with that reformulation.

STEP 2 — For EACH evidence item, decide whether it actually answers hypothesis_question. Fill in per_evidence_answers_question — an object mapping each evidence id to true or false. Rules:
  - answers_question=true ONLY if the evidence directly speaks to the specific actors and specific mechanism named in the hypothesis_question. Evidence about the general industry, adjacent competitors not named in the hypothesis, or related-but-distinct mechanisms does NOT answer the question and gets false.
  - Being topically related or coming from a high-authority source is NOT sufficient for true.

STEP 3 — ENUMERATE the source URLs before any scoring. Do NOT skip, do NOT estimate. Produce two exhaustive lists:
  supporting_source_urls: an array of every distinct source_url_or_identifier string that appears on ANY [evidence_for] block. Deduplicate exact string matches, one entry per distinct URL. Include EVERY distinct URL — do NOT filter by answers_question value, do NOT filter by authority tier, do NOT filter by topic. Include URLs whose items have answers_question=false. This is a RAW COUNT of input URLs, not a filtered count.
  contradicting_source_urls: same procedure, over [evidence_against] blocks.
The harness derives distinct-source counts from these arrays' lengths. Do not report separate count integers.

STEP 4 — Score using these BANDS, NOT a single ceiling:
  - If ZERO items have answers_question=true: validation_score MUST fall in [0.30, 0.65]. Ecosystem/topical evidence sets context (raising within the band by source diversity and authority) but cannot escape it.
  - If SOME items have answers_question=true (at least one, but not all): validation_score MUST fall in [0.55, 0.90]. Position within the band reflects how many items answer plus their authority tier.
  - If ALL items have answers_question=true: validation_score MUST fall in [0.75, 0.95]. Position within the band reflects authority tier and source diversity.
Within any band, weight higher-authority sources more than lower-authority ones. Contradicting evidence lowers the score within its band.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "hypothesis_question": string,
  "per_evidence_answers_question": { "<evidence_id>": true | false, ... },
  "supporting_source_urls": string[],
  "contradicting_source_urls": string[],
  "validation_score": number (0 to 1),
  "rationale": string
}`;

// =============================================================
// Variant 8 — V5 hybrid, with count-reporting REMOVED from model
// entirely.
//
// Root cause of V3/V4/V7's contamination: we've been asking the
// mid-tier model to reproduce a value the backend can already
// compute deterministically. Every prior bench run has computed
// "ground truth" distinct-source counts as a Set().size over the
// input; the model was just being asked to match that number.
// When adjacent semantic fields (answers_question, per_evidence_
// classification) live in the same schema, the model conflates
// them with the count. Removing the surface that invites the
// conflation removes the failure mode.
//
// V8's design:
//   * Backend (harness) computes distinct supporting/contradicting
//     source counts via the same Set().size logic used for ground
//     truth in every prior report. Backend also derives the highest
//     source_authority_tier present in each polarity group — a
//     required input to §7's cluster-weighting invariant, and
//     equally deterministic (nothing to hallucinate).
//   * These facts get injected into the USER PROMPT as a locked
//     preamble: "There are exactly N supporting sources ..., treat
//     these as fixed, do not recompute or report them."
//   * Model output schema has ZERO count fields. Only:
//     hypothesis_question, per_evidence_answers_question,
//     validation_score, rationale.
//   * V5's banded scoring and hypothesis_question reformulation
//     are otherwise intact — this changes what the model is asked
//     to report, not what it's asked to reason about.
// =============================================================
const V8_BACKEND_COUNTS = `You are the Confidence Agent (Evaluator) in a larger opportunity-evaluation system.

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

interface VariantResult {
  name: string;
  rawResponse: string;
  score: number | null;
  distinctSupporting: number | null;
  distinctContradicting: number | null;
  rationale: string | null;
  extra: unknown;
  boundedRuleViolations: string[];
  parseErrors: string[];
}

interface RunVariantOptions {
  // When true, distinct source counts came from the backend (see
  // computeBackendFacts). Model output has no count fields; the
  // reported counts on the result come from the backend numbers,
  // and no bounded-rule count check is performed (the backend
  // numbers ARE ground truth by construction).
  backendCounts?: BackendComputedFacts;
}

async function runVariant(
  name: string,
  systemPrompt: string,
  userPrompt: string,
  llm: LLMClient,
  actualDistinctSupporting: number,
  actualDistinctContradicting: number,
  options: RunVariantOptions = {}
): Promise<VariantResult> {
  const rawResponse = await llm.complete(systemPrompt, userPrompt);
  const parseErrors: string[] = [];
  const boundedRuleViolations: string[] = [];
  let score: number | null = null;
  let distinctSupporting: number | null = null;
  let distinctContradicting: number | null = null;
  let rationale: string | null = null;
  let extra: unknown = null;

  try {
    const jsonBlock = extractJsonBlock(rawResponse);
    if (!jsonBlock) {
      parseErrors.push("no balanced { ... } block found in response");
      return {
        name,
        rawResponse,
        score,
        distinctSupporting,
        distinctContradicting,
        rationale,
        extra,
        boundedRuleViolations,
        parseErrors,
      };
    }
    const json = JSON.parse(jsonBlock);
    // Baseline schema is the strict lower bound; extra fields in V3/V4
    // (per_evidence_classification / hypothesis_question / etc.) are
    // preserved separately for reporting but not enforced.
    const result = ConfidenceOutputSchema.safeParse(json);
    if (!result.success) {
      parseErrors.push(result.error.toString());
    } else {
      score = result.data.validation_score;
      // Count source of truth, in preference order:
      //   1. Backend-computed (V8): the harness computed the counts
      //      deterministically before the LLM call; they ARE ground
      //      truth, no bounded-rule check needed.
      //   2. Model URL arrays (V6/V7 count-lock): count is derived
      //      from array length. Check against ground truth.
      //   3. Model-reported integer (V1–V5): as-is.
      if (options.backendCounts) {
        distinctSupporting = options.backendCounts.distinctSupportingSources;
        distinctContradicting = options.backendCounts.distinctContradictingSources;
      } else if (result.data.supporting_source_urls && result.data.contradicting_source_urls) {
        distinctSupporting = result.data.supporting_source_urls.length;
        distinctContradicting = result.data.contradicting_source_urls.length;
      } else {
        distinctSupporting =
          result.data.distinct_supporting_source_count ?? result.data.total_supporting_input_sources ?? null;
        distinctContradicting =
          result.data.distinct_contradicting_source_count ?? result.data.total_contradicting_input_sources ?? null;
      }
      rationale = result.data.rationale;
      if (!options.backendCounts) {
        if (distinctSupporting !== actualDistinctSupporting) {
          boundedRuleViolations.push(
            `supporting_source_count=${distinctSupporting} but actual=${actualDistinctSupporting}`
          );
        }
        if (distinctContradicting !== actualDistinctContradicting) {
          boundedRuleViolations.push(
            `contradicting_source_count=${distinctContradicting} but actual=${actualDistinctContradicting}`
          );
        }
      }
    }
    const knownKeys = new Set([
      "validation_score",
      "distinct_supporting_source_count",
      "distinct_contradicting_source_count",
      "total_supporting_input_sources",
      "total_contradicting_input_sources",
      "supporting_source_urls",
      "contradicting_source_urls",
      "rationale",
    ]);
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      if (!knownKeys.has(k)) extras[k] = v;
    }
    extra = Object.keys(extras).length > 0 ? extras : null;
  } catch (err) {
    parseErrors.push(`JSON parse failed: ${(err as Error).message}`);
  }
  return {
    name,
    rawResponse,
    score,
    distinctSupporting,
    distinctContradicting,
    rationale,
    extra,
    boundedRuleViolations,
    parseErrors,
  };
}

async function main() {
  const hypothesisId = process.argv[2];
  if (!hypothesisId) throw new Error("usage: experimentConfidencePrompts.ts <hypothesisId>");

  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: hypothesisId } });
  if (!hypothesis) throw new Error(`no hypothesis ${hypothesisId}`);
  const refs = await prisma.nodeSourceRef.findMany({
    where: { nodeId: hypothesisId, nodeType: "hypothesis" },
  });
  const evidenceRows = await prisma.evidence.findMany({
    where: { id: { in: refs.map((r) => r.evidenceId) }, status: "active" },
  });
  const polarity = new Map(refs.map((r) => [r.evidenceId, r.evidencePolarity]));
  const toItem = (e: (typeof evidenceRows)[number]): EvidenceItem => ({
    id: e.id,
    sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
    sourceAuthorityTier: e.sourceAuthorityTier,
    text: e.extractedFact,
  });
  const evidenceFor = evidenceRows.filter((e) => polarity.get(e.id) === "supporting").map(toItem);
  const evidenceAgainst = evidenceRows.filter((e) => polarity.get(e.id) === "contradicting").map(toItem);
  const actualDistinctSupporting = new Set(evidenceFor.map((e) => e.sourceUrlOrIdentifier)).size;
  const actualDistinctContradicting = new Set(evidenceAgainst.map((e) => e.sourceUrlOrIdentifier)).size;

  console.log(`Hypothesis: ${hypothesis.statement}\n`);
  console.log(`Evidence pool: ${evidenceFor.length} supporting, ${evidenceAgainst.length} contradicting`);
  console.log(`Distinct sources — actual: supporting=${actualDistinctSupporting}, contradicting=${actualDistinctContradicting}\n`);

  const userPrompt = buildUserPrompt(hypothesis.statement, evidenceFor, evidenceAgainst);
  const backendFacts = computeBackendFacts(evidenceFor, evidenceAgainst);
  const userPromptWithFacts = buildGivenFactsBlock(backendFacts) + userPrompt;
  const config = await modelRoutingConfigRepository.latestForAgent("Confidence");
  if (!config) throw new Error("no model_routing_config for Confidence");
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");
  const llm = new BenchNimClient(apiKey, config.nimModelId, 8192);
  console.log(`Model: ${config.nimModelId} (tier=${config.tier}) — bench max_tokens=8192\n`);

  const allVariants: { key: string; name: string; prompt: string; injectBackendCounts?: boolean }[] = [
    { key: "V1", name: "V1 baseline", prompt: V1_BASELINE },
    { key: "V2", name: "V2 mechanism-specificity instruction", prompt: V2_MECHANISM_INSTRUCTION },
    { key: "V3", name: "V3 structured intermediate classification", prompt: V3_STRUCTURED_CLASSIFICATION },
    { key: "V4", name: "V4 answer-the-question test", prompt: V4_ANSWER_THE_QUESTION },
    { key: "V5", name: "V5 hybrid: answer-question + banded score + decoupled counts", prompt: V5_HYBRID_BANDED },
    { key: "V6", name: "V6 baseline + URL-enumeration count-lock", prompt: V6_COUNT_LOCK },
    { key: "V7", name: "V7 V5 + URL-enumeration count-lock", prompt: V7_V5_COUNT_LOCK },
    { key: "V8", name: "V8 V5 with backend-computed counts injected as facts", prompt: V8_BACKEND_COUNTS, injectBackendCounts: true },
  ];
  const variantFilter = process.argv[3];
  const selected = variantFilter
    ? new Set(variantFilter.split(",").map((s) => s.trim().toUpperCase()))
    : null;
  const variants = selected ? allVariants.filter((v) => selected.has(v.key)) : allVariants;
  if (variants.length === 0) {
    throw new Error(`no variants matched filter "${variantFilter}" (available: ${allVariants.map((v) => v.key).join(",")})`);
  }
  const repeats = process.argv[4] ? Math.max(1, parseInt(process.argv[4], 10)) : 1;
  if (repeats > 1) console.log(`Repeats per variant: ${repeats}\n`);

  const results: VariantResult[] = [];
  for (const v of variants) {
    for (let attempt = 1; attempt <= repeats; attempt++) {
      const attemptLabel = repeats > 1 ? `${v.name} (attempt ${attempt}/${repeats})` : v.name;
      console.log(`\n──────── Running ${attemptLabel} ────────`);
      const r = await runVariant(
        attemptLabel,
        v.prompt,
        v.injectBackendCounts ? userPromptWithFacts : userPrompt,
        llm,
        actualDistinctSupporting,
        actualDistinctContradicting,
        v.injectBackendCounts ? { backendCounts: backendFacts } : {}
      );
      results.push(r);
      console.log(`score=${r.score} sup=${r.distinctSupporting} con=${r.distinctContradicting}`);
      if (r.boundedRuleViolations.length > 0) console.log(`bounded-rule violations: ${r.boundedRuleViolations.join("; ")}`);
      if (r.parseErrors.length > 0) console.log(`parse errors: ${r.parseErrors.join("; ")}`);
    }
  }

  console.log("\n\n============ SIDE-BY-SIDE ============");
  for (const r of results) {
    console.log(`\n### ${r.name}`);
    console.log(`  validation_score:                    ${r.score}`);
    console.log(`  distinct_supporting_source_count:    ${r.distinctSupporting}`);
    console.log(`  distinct_contradicting_source_count: ${r.distinctContradicting}`);
    console.log(`  bounded-rule violations:             ${r.boundedRuleViolations.length === 0 ? "(none)" : r.boundedRuleViolations.join("; ")}`);
    console.log(`  rationale:`);
    console.log(`    ${r.rationale ?? "(unparseable)"}`);
    if (r.extra) {
      console.log(`  extra fields:`);
      console.log(`    ${JSON.stringify(r.extra, null, 4).split("\n").join("\n    ")}`);
    }
    if (r.parseErrors.length > 0) {
      console.log(`  parse errors: ${r.parseErrors.join("; ")}`);
      console.log(`  RAW: ${r.rawResponse.substring(0, 500)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
