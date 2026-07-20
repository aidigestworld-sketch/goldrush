// Hypothesis Sandbox — Phase 5's first extraction sandbox. Same
// pattern as Discovery/Expansion/CompetitiveAnalysis: no DAG, no
// Orchestrator, no DB writes — raw structured input straight through
// Hypothesis Agent's real prompt/contract (AI_AGENTS.md §5), output
// validated against a schema with mechanical grounding checks.
//
// CARRIES FORWARD the SYMPTOM → MECHANISM → GAP prompt scaffolding
// that empirically worked for Expansion (VERTICAL_BASELINE.md §8) —
// Hypothesis's whole job is the same kind of synthesis one level up
// the graph: given a Problem (already gap-framed, ideally) and the
// ExistingSolutions that address similar problems, does any of them
// actually solve THIS specific gap, or is there white space?
//
// BOUNDED SYNTHESIS RULE — OPERATIONAL SUBSTITUTION FOR MVP:
// AI_AGENTS.md §5's rule requires evidence_for to cite at least 2
// evidence rows with DISTINCT cluster_id under the current
// cluster_version. cluster_id is never populated until Reclustering
// runs (out of MVP scope, GRAPH_SCHEMA.md §4.13) — every Evidence row
// has cluster_id = NULL right now, so a literal "distinct cluster_id"
// check is unenforceable today, not just untested. Substituted here
// with "distinct sourceUrlOrIdentifier" (distinct primary source
// documents) as the practical stand-in for independence until real
// clustering exists — same spirit (not one source pretending to be
// two), different mechanism. Flagged explicitly, not silently assumed
// equivalent.
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import { parseLlmJson } from "./parseLlmJson";

export interface HypothesisInputProblem {
  id: string;
  label: string;
  problemMaturity: string;
  currentWorkaroundDescription: string | null;
}

export interface HypothesisInputExistingSolution {
  id: string;
  label: string;
  positioningSummary: string | null;
  pricingSummary: string | null;
}

export interface HypothesisInputEvidence {
  id: string;
  sourceUrlOrIdentifier: string;
  text: string;
}

export interface HypothesisSandboxInput {
  problem: HypothesisInputProblem;
  existingSolutions: HypothesisInputExistingSolution[];
  evidence: HypothesisInputEvidence[]; // the evidence backing problem + existing solutions, for citation
}

const HypothesisCandidateSchema = z
  .object({
    statement: z.string().min(1),
    gap_type: z.enum(["positioning", "pricing", "business_model", "distribution"]),
    evidence_for: z.array(z.string()).min(2), // Bounded Synthesis Rule: at least 2, checked for distinct source below
    evidence_against: z.array(z.string()),
    // FOUND VIA LIVE RUN: this field was missing, and its absence
    // caused a real bug — evidence_for is epistemic grounding (what
    // PROVES the claim), which is NOT the same as which
    // ExistingSolutions the hypothesis is actually ABOUT. A live run
    // produced a statement naming three specific competitors, but
    // cited only underlying mechanism evidence (Shopify Community,
    // Shopifreaks) in evidence_for — correct epistemic behavior, but
    // it meant hypothesis_sources ended up linking to NONE of the
    // three competitors the hypothesis was actually evaluating,
    // because the live agent was (wrongly) deriving topical scope
    // from evidence_for's citations. GRAPH_SCHEMA.md's hyperedge is
    // explicitly "(Problem, ExistingSolution SET) → Hypothesis" —
    // topical scope, not citation subset. This field captures that
    // scope directly and explicitly, instead of inferring it from a
    // field meant for something else.
    existing_solutions_considered: z.array(z.string()),
    missing_data: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })
  .refine((h) => h.evidence_for.length >= 2, {
    message: "evidence_for must cite at least 2 sources — Bounded Synthesis Rule",
  });

const HypothesisOutputSchema = z.object({
  hypotheses: z.array(HypothesisCandidateSchema),
});

export type HypothesisOutput = z.infer<typeof HypothesisOutputSchema>;

const SYSTEM_PROMPT = `You are the Hypothesis Agent in a larger opportunity-evaluation system.

Your job: given one Problem and the ExistingSolutions that address similar problems, determine whether any ExistingSolution actually solves THIS specific problem, or whether a white-space gap exists — an underserved angle no competitor's positioning addresses.

The same discipline that applies to Problem-extraction applies here, one level up: don't stop at naming that a gap might exist ("no competitor mentions X") — state what specific capability is missing and why that matters, the same SYMPTOM → MECHANISM → GAP chain used to extract this Problem in the first place. A hypothesis like "competitors don't address this" is too shallow; "competitors' retention/dunning tooling assumes voluntary churn and has no mechanism to detect or route platform-forced cancellations differently" is the right depth.

Rules you MUST follow exactly:
- Read ONLY the provided Problem, ExistingSolutions, and Evidence. No outside knowledge about what these companies "probably" offer beyond what's given.
- Every hypothesis's evidence_for MUST cite at least 2 evidence ids, and those 2+ must come from genuinely different source documents (not the same source cited twice) — this is the Bounded Synthesis Rule: a hypothesis built from what is really one source, cited multiple times, is not synthesis and will be rejected.
- existing_solutions_considered is DIFFERENT from evidence_for: list every ExistingSolution id your statement actually discusses or evaluates (e.g. if your statement names "Recharge, Bold, and Loop," all three of their ids belong here), regardless of which raw evidence documents you cited to support the claim. evidence_for is about what PROVES the statement; existing_solutions_considered is about which competitors the statement is ABOUT. A hypothesis naming three competitors but leaving existing_solutions_considered empty or incomplete is incorrectly scoped.
- You MUST also populate evidence_against (what would argue against this gap existing — e.g. if a competitor's positioning partially addresses it) and missing_data (what's genuinely unknown) in the same output. If you cannot find any real evidence_against after actually considering the ExistingSolutions provided, evidence_against may be an empty array — but only after genuinely checking each ExistingSolution's positioning, not by default.
- Do NOT propose a solution. State the gap, not what should be built to fill it — that's a downstream concern, not yours.
- Do not invent facts about the Problem or ExistingSolutions not present in what you were given.

Respond with ONLY valid JSON matching this exact shape. Your response MUST begin with { and end with }. Do not include any explanation, preamble, commentary, or markdown formatting before or after the JSON object — not even a single word:
{
  "hypotheses": [{
    "statement": string,
    "gap_type": "positioning" | "pricing" | "business_model" | "distribution",
    "evidence_for": string[],
    "evidence_against": string[],
    "existing_solutions_considered": string[],
    "missing_data": string[],
    "confidence": number (0 to 1)
  }]
}`;

function buildUserPrompt(input: HypothesisSandboxInput): string {
  const problemBlock = `[problem id="${input.problem.id}"]
label: ${input.problem.label}
maturity: ${input.problem.problemMaturity}
current_workaround: ${input.problem.currentWorkaroundDescription ?? "none stated"}
[/problem]`;

  const solutionBlocks = input.existingSolutions
    .map(
      (s) =>
        `[existing_solution id="${s.id}"]
label: ${s.label}
positioning: ${s.positioningSummary ?? "not stated"}
pricing: ${s.pricingSummary ?? "not stated"}
[/existing_solution]`
    )
    .join("\n\n");

  const evidenceBlocks = input.evidence
    .map((e) => `[evidence id="${e.id}" source="${e.sourceUrlOrIdentifier}"]\n${e.text}\n[/evidence]`)
    .join("\n\n");

  return `${problemBlock}\n\n${solutionBlocks}\n\n${evidenceBlocks}`;
}

export interface HypothesisSandboxResult {
  rawResponse: string;
  parsed: HypothesisOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[];
}

export async function runHypothesisSandbox(
  llm: LLMClient,
  input: HypothesisSandboxInput
): Promise<HypothesisSandboxResult> {
  const userPrompt = buildUserPrompt(input);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  let parsed: HypothesisOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];

  const parseResult = parseLlmJson(rawResponse);
  if (parseResult.error) {
    validationErrors.push(parseResult.error);
  } else {
    const result = HypothesisOutputSchema.safeParse(parseResult.data);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      parsed = result.data;

      // Build a map from evidence/problem/solution id -> "source identity"
      // for the distinct-source check. Problem and ExistingSolution ids
      // count as their own distinct sources too (a hypothesis citing the
      // Problem plus one ExistingSolution cites 2 genuinely different
      // things, even though neither is literally an `evidence` row).
      const idToSourceIdentity = new Map<string, string>();
      idToSourceIdentity.set(input.problem.id, `problem:${input.problem.id}`);
      for (const s of input.existingSolutions) idToSourceIdentity.set(s.id, `existing_solution:${s.id}`);
      for (const e of input.evidence) idToSourceIdentity.set(e.id, `evidence-source:${e.sourceUrlOrIdentifier}`);

      const validIds = new Set(idToSourceIdentity.keys());

      for (const h of parsed.hypotheses) {
        const badRefs = h.evidence_for.filter((ref) => !validIds.has(ref));
        if (badRefs.length > 0) {
          boundedRuleViolations.push(
            `Hypothesis "${h.statement}" cites evidence_for ids not present in input: ${badRefs.join(", ")} — hallucinated citation`
          );
          continue;
        }
        const distinctSources = new Set(h.evidence_for.map((ref) => idToSourceIdentity.get(ref)));
        if (distinctSources.size < 2) {
          boundedRuleViolations.push(
            `Hypothesis "${h.statement}" cites ${h.evidence_for.length} evidence_for id(s) but they resolve to only ${distinctSources.size} distinct source(s) — Bounded Synthesis Rule violation (not real synthesis from independent sources)`
          );
        }

        const validSolutionIds = new Set(input.existingSolutions.map((s) => s.id));
        const badSolutionRefs = h.existing_solutions_considered.filter((id) => !validSolutionIds.has(id));
        if (badSolutionRefs.length > 0) {
          boundedRuleViolations.push(
            `Hypothesis "${h.statement}" lists existing_solutions_considered ids not present in input: ${badSolutionRefs.join(", ")} — hallucinated competitor reference`
          );
        }
      }
    }
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations };
}
