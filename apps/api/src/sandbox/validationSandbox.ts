// Validation Sandbox — Validation Agent (Collector), AI_AGENTS.md §6.
//
// HONEST SCOPE LIMIT, stated up front: Validation's real contract
// requires ACTIVELY QUERYING for disconfirming evidence — an action,
// not just reasoning over given text. No live search-capable
// connector exists yet (Phase 2's Data Pipeline only covers
// review_complaint/competitor_material, not open-ended search). This
// sandbox therefore tests only the CLASSIFICATION half of the job —
// given a hypothesis and a set of candidate evidence (as if a search
// had already found them), can the model correctly judge which
// support, which contradict, and which are irrelevant? It does not
// and cannot test the active-search half until a real search
// capability exists. Don't read a clean pass here as "Validation
// Agent is done" — it's "the reasoning half works."
//
// The harder test built into this sandbox: NOT "does obviously-
// irrelevant evidence get correctly ignored" (easy), but "does
// superficially-similar evidence that addresses a DIFFERENT mechanism
// get correctly recognized as a partial, not full, contradiction?"
// Real fixture: Loop Subscriptions genuinely markets a "voluntary vs
// involuntary churn" framing — but that framing is about payment-
// failure-driven churn, not the Shop-Pay-card-removal mechanism this
// hypothesis is specifically about. A shallow classifier sees matching
// keywords and calls it a full contradiction; a careful one notices
// the mechanism doesn't actually match.
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import { parseLlmJson } from "./parseLlmJson";

export interface ValidationHypothesis {
  id: string;
  statement: string;
}

export interface ValidationCandidateEvidence {
  id: string;
  sourceUrlOrIdentifier: string;
  text: string;
}

export interface ValidationSandboxInput {
  hypothesis: ValidationHypothesis;
  candidates: ValidationCandidateEvidence[];
}

const ClassifiedEvidenceSchema = z.object({
  evidence_id: z.string().min(1),
  classification: z.enum(["supports", "contradicts", "inconclusive"]),
  // Required and must be substantive (min length enforced below, not
  // just non-empty) — forces the model to articulate WHY, which is
  // where mechanism-match-vs-keyword-match reasoning either shows up
  // or doesn't. A one-word note can't do that.
  note: z.string().min(20),
});

const ValidationOutputSchema = z.object({
  classified_evidence: z.array(ClassifiedEvidenceSchema),
  unresolved_questions: z.array(z.string()),
  additional_search_queries_would_run: z.array(z.string()), // stands in for "actively query" — see file header
});

export type ValidationOutput = z.infer<typeof ValidationOutputSchema>;

const SYSTEM_PROMPT = `You are the Validation Agent (Collector) in a larger opportunity-evaluation system.

Your job: given a Hypothesis and a set of candidate evidence documents, classify each one as "supports", "contradicts", or "inconclusive" with respect to the hypothesis.

The single most important rule: superficial keyword overlap is NOT the same as actually addressing the hypothesis's specific mechanism. A competitor that talks about "voluntary vs involuntary churn" in general is not automatically evidence against a hypothesis about ONE SPECIFIC involuntary-churn mechanism (e.g. a platform silently cancelling a subscription when a payment card is removed, as distinct from a payment simply failing/declining). Read carefully whether the evidence is really about the same mechanism the hypothesis describes, or just a related-sounding topic. If a candidate is only related by broad topic but doesn't address the specific mechanism, classify it "inconclusive" (or "contradicts" with a note explaining it's only a partial/weak contradiction) — do not treat topical overlap as if it fully settles the question either way.

Every classification's note MUST explain the actual reasoning — specifically, whether the mechanism in the evidence matches the mechanism in the hypothesis, not just whether the general topic overlaps.

You are NOT scoring or producing a final validation verdict — that's a separate agent's job. You are only classifying and flagging what remains genuinely unresolved.

Respond with ONLY valid JSON matching this exact shape. Your response MUST begin with { and end with }. Do not include any explanation, preamble, commentary, or markdown formatting before or after the JSON object — not even a single word:
{
  "classified_evidence": [{
    "evidence_id": string,
    "classification": "supports" | "contradicts" | "inconclusive",
    "note": string
  }],
  "unresolved_questions": string[],
  "additional_search_queries_would_run": string[]
}`;

function buildUserPrompt(input: ValidationSandboxInput): string {
  const hypBlock = `[hypothesis id="${input.hypothesis.id}"]\n${input.hypothesis.statement}\n[/hypothesis]`;
  const candidateBlocks = input.candidates
    .map((c) => `[candidate id="${c.id}" source="${c.sourceUrlOrIdentifier}"]\n${c.text}\n[/candidate]`)
    .join("\n\n");
  return `${hypBlock}\n\n${candidateBlocks}`;
}

export interface ValidationSandboxResult {
  rawResponse: string;
  parsed: ValidationOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[];
}

// One-call classification (used directly by tests and internally by
// runValidationSandboxBatched below). Prefer runValidationSandboxBatched
// for production paths so corpora larger than ~60 rows don't push a
// single LLM call past NIM's ~300s inference gateway wall.
export async function runValidationSandbox(
  llm: LLMClient,
  input: ValidationSandboxInput
): Promise<ValidationSandboxResult> {
  const userPrompt = buildUserPrompt(input);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  let parsed: ValidationOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];

  // parseLlmJson tries native JSON.parse first, falls back to jsonrepair
  // if the model emitted a truncated / unescaped-quote / missing-bracket
  // response. Recovers the 07:34 UTC 2026-07-15 Validation failure
  // (log 60f84683-...) which was a mid-string truncation.
  const parseResult = parseLlmJson(rawResponse);
  if (parseResult.error) {
    validationErrors.push(parseResult.error);
  } else {
    const result = ValidationOutputSchema.safeParse(parseResult.data);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      parsed = result.data;
      const validIds = new Set(input.candidates.map((c) => c.id));
      for (const item of parsed.classified_evidence) {
        if (!validIds.has(item.evidence_id)) {
          boundedRuleViolations.push(
            `Classification cites nonexistent evidence id: ${item.evidence_id} — hallucinated citation`
          );
        }
      }
    }
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations };
}

// Max candidate rows per single LLM call. Chosen empirically from the
// 2026-07-17 diagnostic: 131 rows at ~75K input + 8192 output tokens on
// nvidia/llama-3.3-nemotron-super-49b-v1.5 ran 289s (finish=length),
// right at the 300s NIM gateway wall. Splitting into batches of ≤60
// rows keeps per-batch output well under 4K tokens (~60 rows × ~60
// tokens/row for classification+note) and per-batch input well under
// ~40K tokens, which finishes in ~90–150s per parallel batch — durable
// as the corpus grows because the batch COUNT scales with volume, not
// per-batch time.
export const VALIDATION_MAX_ROWS_PER_BATCH = 60;

// Batched classification. Splits input.candidates into ≤VALIDATION_MAX_ROWS_PER_BATCH
// chunks, runs runValidationSandbox in parallel per chunk, merges results.
//
// Design invariants:
//   - Single hypothesis is passed to every batch — batches partition
//     ONLY candidates, never the hypothesis or the system prompt.
//   - Per-batch classification is independent: the classifier is a
//     per-row judgment against a fixed hypothesis, with no cross-row
//     reasoning. Concatenating classified_evidence across batches is
//     therefore semantically equivalent to a single call. This is the
//     property that makes batching safe for quality.
//   - Fail-loud: if ANY batch fails schema validation, the whole
//     invocation fails (validationErrors non-empty, parsed=null) —
//     partial-success writes would corrupt the audit trail.
//   - rawResponse is a concatenation of per-batch raw responses with
//     an inline delimiter, so agent_execution_log.raw_output remains
//     a single string per Validation run but each batch's raw output
//     is inspectable in the log.
//   - unresolved_questions and additional_search_queries_would_run are
//     merged with de-duplication (case-insensitive, whitespace-normalized) —
//     different batches often surface the same broad gap in the corpus,
//     and duplicating those onto hypothesis.missing_data or the search
//     log would be noise.
export async function runValidationSandboxBatched(
  llm: LLMClient,
  input: ValidationSandboxInput,
  batchSize: number = VALIDATION_MAX_ROWS_PER_BATCH
): Promise<ValidationSandboxResult> {
  if (input.candidates.length <= batchSize) {
    return runValidationSandbox(llm, input);
  }

  const batches: ValidationCandidateEvidence[][] = [];
  for (let i = 0; i < input.candidates.length; i += batchSize) {
    batches.push(input.candidates.slice(i, i + batchSize));
  }

  const perBatch = await Promise.all(
    batches.map((candidates) =>
      runValidationSandbox(llm, { hypothesis: input.hypothesis, candidates })
    )
  );

  const rawResponse = perBatch
    .map((r, i) => `--- batch ${i + 1}/${perBatch.length} ---\n${r.rawResponse}`)
    .join("\n\n");

  const validationErrors = perBatch.flatMap((r, i) =>
    r.validationErrors.map((e) => `[batch ${i + 1}/${perBatch.length}] ${e}`)
  );
  const boundedRuleViolations = perBatch.flatMap((r) => r.boundedRuleViolations);

  if (validationErrors.length > 0 || perBatch.some((r) => r.parsed === null)) {
    return { rawResponse, parsed: null, validationErrors, boundedRuleViolations };
  }

  const dedupe = (values: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
      const key = v.trim().toLowerCase().replace(/\s+/g, " ");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    }
    return out;
  };

  const merged: ValidationOutput = {
    classified_evidence: perBatch.flatMap((r) => r.parsed!.classified_evidence),
    unresolved_questions: dedupe(perBatch.flatMap((r) => r.parsed!.unresolved_questions)),
    additional_search_queries_would_run: dedupe(
      perBatch.flatMap((r) => r.parsed!.additional_search_queries_would_run)
    ),
  };

  return { rawResponse, parsed: merged, validationErrors, boundedRuleViolations };
}
