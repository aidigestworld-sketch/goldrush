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

// Extract the JSON object from a raw model response, tolerating prose
// preamble or markdown fences (e.g. "Based on the candidates...\n{...}").
function extractAndClean(raw: string): string {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) return raw.slice(first, last + 1);
  return raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
}

export async function runValidationSandbox(
  llm: LLMClient,
  input: ValidationSandboxInput
): Promise<ValidationSandboxResult> {
  const userPrompt = buildUserPrompt(input);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  let parsed: ValidationOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];

  try {
    const cleaned = extractAndClean(rawResponse);
    const json = JSON.parse(cleaned);
    const result = ValidationOutputSchema.safeParse(json);
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
  } catch (err) {
    validationErrors.push(`JSON parse failed: ${(err as Error).message}`);
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations };
}
