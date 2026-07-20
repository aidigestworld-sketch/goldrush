// Real FounderFit Agent — Phase 5. AI_AGENTS.md §9, DAG stage 10b.
//
// Reads: the run's Founder profile + the target OpportunityCandidate +
// its composed Market/BusinessModel rows via opportunity_candidate_composition.
// Writes: UPDATE opportunity_candidate SET founder_fit_score,
// founder_fit_rationale; INSERT edge (fits | does_not_fit) from
// founder to candidate. Nothing else, per §9 invariants.
//
// V8-STYLE AUDIT (applied up front rather than discovered the hard
// way): the FounderFit sandbox's schema was reviewed field-by-field
// for anything the backend could compute deterministically that
// would otherwise become the mid-tier model's counting/counting-ish
// failure mode (as V1–V7 did with Confidence). Result of that audit:
// no such field exists here.
//   * founder_fit_score is a synthesis over comparative judgment —
//     not backend-derivable from the profile alone.
//   * matched_strengths is already grounded via a mechanical
//     substring-verification check in founderFitSandbox.ts (each
//     claimed matched_value must actually appear in the founder's
//     corresponding profile field). That's the same shape as
//     validationSandbox's citation-grounding — LLM proposes, backend
//     verifies. Already correct; not moving anything.
//   * gaps and rationale are pure LLM synthesis; no deterministic
//     rewrite.
// So this agent proceeds with a normal LLM-judgment-only output
// schema. The V8-lesson generalization: check for the pattern; if
// it doesn't apply, proceed normally.
//
// FIT-GATE THRESHOLD: OPPORTUNITY_ENGINE.md §8 sets the default
// minimum_fit_threshold at 25/100. Scores at or above the threshold
// get a `fits` edge; below get `does_not_fit`. Kept as a constant
// here (not a config lookup) until scoring_config gains a fit-gate
// column — same pattern as Confidence Agent's VALIDATION_GATE_THRESHOLD.
import { runFounderFitSandbox, type FounderFitSandboxInput, type FounderEvidenceRecord } from "../../sandbox/founderFitSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { founderRepository } from "../../repositories/founder.repository";
import { founderEvidenceRepository } from "../../repositories/founderEvidence.repository";
import { opportunityCandidateRepository } from "../../repositories/opportunityCandidate.repository";
import { edgeRepository } from "../../repositories/edge.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";
import { tryResolveCandidateIdForRun } from "../../orchestrator/idResolvers";

export const MINIMUM_FIT_THRESHOLD = 25;

export interface FounderFitRunResult {
  candidateId: string | null;
  founderFitScore: number | null;
  founderFitRationale: string | null;
  fitEdgeType: "fits" | "does_not_fit" | null;
  matchedStrengthCount: number | null;
  gapsCount: number | null;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

// candidateId is `string | undefined` (not required). The agent resolves
// via tryResolveCandidateIdForRun so `id: undefined` can never reach the
// underlying prisma.opportunityCandidate.findUnique inside
// opportunityCandidateRepository.findById.
export async function runFounderFitAgent(
  runId: string,
  candidateId: string | undefined,
  founderId: string,
  llm: LLMClient
): Promise<FounderFitRunResult> {
  const resolvedCandidateId = await tryResolveCandidateIdForRun(runId, candidateId);
  if (!resolvedCandidateId) return skip(null, "no candidate found for run");
  const [founder, candidate, founderEvidenceRows] = await Promise.all([
    founderRepository.findById(founderId),
    opportunityCandidateRepository.findById(resolvedCandidateId),
    founderEvidenceRepository.findByFounderId(founderId),
  ]);
  if (!founder) {
    return skip(resolvedCandidateId, `founder ${founderId} not found`);
  }
  if (!candidate) {
    return skip(resolvedCandidateId, `opportunity_candidate ${resolvedCandidateId} not found`);
  }
  // Mode input filter per §9: candidate must be 'candidate' status
  // AND opportunity_quality must already be set (Scoring must have
  // run first — DAG dependency).
  if (candidate.status !== "candidate") {
    return skip(resolvedCandidateId, `candidate ${resolvedCandidateId} is status='${candidate.status}', not 'candidate'`);
  }
  if (candidate.opportunityQuality === null) {
    return skip(
      resolvedCandidateId,
      `candidate ${resolvedCandidateId} has opportunity_quality=NULL — Scoring Agent must run first (DAG stage 9 → 10b)`
    );
  }

  // Read the composed Market + BusinessModel via
  // opportunity_candidate_composition. §9's read scope names these
  // two specifically as the sources for the opportunity's
  // requirements summary.
  const compositionRows = await prisma.opportunityCandidateComposition.findMany({
    where: { candidateId: resolvedCandidateId },
  });
  const marketId = compositionRows.find((r) => r.role === "market")?.nodeId;
  const businessModelId = compositionRows.find((r) => r.role === "business_model")?.nodeId;
  if (!marketId || !businessModelId) {
    return skip(
      resolvedCandidateId,
      `candidate ${resolvedCandidateId} composition is incomplete (market=${marketId ?? "MISSING"}, business_model=${businessModelId ?? "MISSING"}) — Composition must have committed all 5 role rows`
    );
  }
  const [market, businessModel] = await Promise.all([
    prisma.market.findUnique({ where: { id: marketId } }),
    prisma.businessModel.findUnique({ where: { id: businessModelId } }),
  ]);
  if (!market || !businessModel) {
    return skip(
      resolvedCandidateId,
      `composed rows missing at DB level (market=${market ? "ok" : "MISSING"}, business_model=${businessModel ? "ok" : "MISSING"})`
    );
  }

  const requirementsSummary = buildRequirementsSummary({
    marketLabel: market.label,
    marketMaturity: market.maturityStage,
    marketCategoryTags: market.categoryTags,
    // The BM below is a competitor's model, not the entrant's own —
    // labeled explicitly as such in the prompt so the LLM frames
    // gaps as competitive-comparison, not "founder's own plan"
    // (AI_AGENTS.md §8 semantics).
    competitorBusinessModelType: businessModel.modelType,
    competitorBusinessModelLabel: businessModel.label,
    competitorOperationalComplexity: businessModel.operationalComplexityEstimate,
    competitorCapitalIntensity: businessModel.capitalIntensityEstimate,
    competitorMarginProfile: businessModel.marginProfile,
  });

  // Map DB evidence rows to the sandbox's FounderEvidenceRecord shape.
  // targetField is stored as snake_case in DB — matches the enum exactly.
  const founderEvidence: FounderEvidenceRecord[] = founderEvidenceRows.map((e) => ({
    id: e.id,
    targetField: e.targetField as FounderEvidenceRecord["targetField"],
    extractedValue: e.extractedValue,
    rawAnswer: e.rawAnswer,
  }));

  const sandboxInput: FounderFitSandboxInput = {
    founder: {
      id: founder.id,
      expertise: founder.expertise ?? [],
      distributionAssets: founder.distributionAssets ?? [],
      // Pass null through directly for every nullable scalar —
      // founderFitSandbox.ts handles null by showing "[not provided]" in
      // the prompt and treating the field as an empty set in the
      // bounded-rule check so no matched_strength can be constructed
      // from an absent value.
      capitalAvailability: founder.capitalAvailability ?? null,
      teamSize: founder.teamSize ?? null,
      geography: founder.geography ?? null,
      founderEvidence,
      // Legacy = no interview answers exist (pre-Intake Engine founder).
      // String-matching fallback applies; no evidence_id citations required.
      isLegacy: founderEvidence.length === 0,
    },
    opportunity: {
      label: candidate.id.slice(0, 8), // no label field on OpportunityCandidate itself; use short id as a display handle
      requirementsSummary,
    },
  };

  return agentExecutionLogService.run(
    {
      runId,
      agentName: "FounderFit",
      candidateId: resolvedCandidateId,
      modelUsed: (llm as { model?: string }).model ?? null,
    },
    async (ctx) => {
      const result = await runFounderFitSandbox(llm, sandboxInput);
      ctx.setRawOutput(result.rawResponse);

      if (!result.parsed) {
        throw new Error(
          `FounderFit Agent output failed schema validation: ${result.validationErrors.join("; ")}`
        );
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          candidateId: resolvedCandidateId,
          founderFitScore: null,
          founderFitRationale: null,
          fitEdgeType: null,
          matchedStrengthCount: null,
          gapsCount: null,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      await opportunityCandidateRepository.setFounderFit(
        candidate.id,
        result.parsed.founder_fit_score,
        result.parsed.rationale
      );

      const fitEdgeType: "fits" | "does_not_fit" =
        result.parsed.founder_fit_score >= MINIMUM_FIT_THRESHOLD ? "fits" : "does_not_fit";
      await edgeRepository.create(fitEdgeType, founder.id, "founder", candidate.id, "opportunity_candidate");

      return {
        candidateId: resolvedCandidateId,
        founderFitScore: result.parsed.founder_fit_score,
        founderFitRationale: result.parsed.rationale,
        fitEdgeType,
        matchedStrengthCount: result.parsed.matched_strengths.length,
        gapsCount: result.parsed.gaps.length,
        boundedRuleViolations: [],
        skipped: false,
      };
    },
    // graph_mutation_count semantics: 1 column-write bundle on candidate
    // (founder_fit_score + founder_fit_rationale in one UPDATE) + 1 new
    // edge row = 2.
    (result) => ({ graphMutationCount: result.skipped ? 0 : 2 })
  );
}

function skip(candidateId: string | null, reason: string): FounderFitRunResult {
  return {
    candidateId,
    founderFitScore: null,
    founderFitRationale: null,
    fitEdgeType: null,
    matchedStrengthCount: null,
    gapsCount: null,
    boundedRuleViolations: [],
    skipped: true,
    skipReason: reason,
  };
}

function buildRequirementsSummary(inputs: {
  marketLabel: string | null;
  marketMaturity: string;
  marketCategoryTags: string[];
  competitorBusinessModelType: string;
  competitorBusinessModelLabel: string | null;
  competitorOperationalComplexity: number | null;
  competitorCapitalIntensity: number | null;
  competitorMarginProfile: number | null;
}): string {
  const marketPart = `Market: ${inputs.marketLabel ?? "unlabeled"} (${inputs.marketMaturity})${
    inputs.marketCategoryTags.length > 0 ? `, tags: ${inputs.marketCategoryTags.join(", ")}` : ""
  }.`;
  const competitorLabel = inputs.competitorBusinessModelLabel ?? "an unnamed incumbent";
  const bmPart =
    `Competitive benchmark (the closest existing competitor's model — what a new entrant would be competing against, NOT a plan the founder would run): ` +
    `${competitorLabel}'s model = ${inputs.competitorBusinessModelType}.`;
  const opPart =
    inputs.competitorOperationalComplexity !== null
      ? `Competitor's operational complexity signal: ${inputs.competitorOperationalComplexity.toFixed(2)} (higher = deeper moat an entrant must replicate).`
      : "";
  const capPart =
    inputs.competitorCapitalIntensity !== null
      ? `Competitor's capital intensity signal: ${inputs.competitorCapitalIntensity.toFixed(2)} (higher = more capital needed to build a comparable offering).`
      : "";
  const marginPart =
    inputs.competitorMarginProfile !== null
      ? `Competitor's margin profile: ${inputs.competitorMarginProfile.toFixed(2)} (structure the entrant's own margins would be benchmarked against).`
      : "";
  return [marketPart, bmPart, opPart, capPart, marginPart].filter((s) => s.length > 0).join(" ");
}
