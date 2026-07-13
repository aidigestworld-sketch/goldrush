// Real Scoring Agent — Phase 5 live wrapper around the deterministic
// scoring function in ../scoring.ts.
//
// AI_AGENTS.md §10 / DAG stage 9. Deterministic (no LLM call): reads
// the target OpportunityCandidate's composed 5 rows via
// opportunity_candidate_composition, reads the vertical's latest
// scoring_config snapshot, calls computeOpportunityQuality() (pure
// function), and UPDATEs the candidate row's opportunity_quality
// column.
//
// Writes ONLY: opportunity_candidate.opportunity_quality. NEVER any
// other scoring field, per §10 invariants:
//   MUST NOT set founder_fit_score, venture_score, confidence_score,
//   coverage, agreement, or freshness.
//
// Note on the BM read: the business_model row this agent reads via
// opportunity_candidate_composition is a competitor's model, not
// the entrant's own (per AI_AGENTS.md §8 semantics). Scoring's
// margin and feasibility sub-scores are interpreted under that
// framing — see scoring.ts's header for the full explanation.
import { computeOpportunityQuality, type ScoringInputs, type ScoringConfigWeights } from "../scoring";
import { scoringConfigRepository } from "../../repositories/scoringConfig.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

export interface ScoringRunResult {
  opportunityQuality: number | null;
  subScores: {
    demand: number;
    hypothesis: number;
    margin: number;
    feasibility: number;
    distribution: number;
    timing: number;
  } | null;
  scoringConfigVersion: number | null;
  skipped: boolean;
  skipReason?: string;
}

export async function runScoringAgent(runId: string, candidateId: string, vertical: string): Promise<ScoringRunResult> {
  const candidate = await prisma.opportunityCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) return skip(`candidate ${candidateId} not found`);
  if (candidate.status !== "candidate") return skip(`candidate ${candidateId} is status='${candidate.status}'`);
  if (candidate.opportunityQuality !== null) {
    return skip(`candidate ${candidateId} already has opportunity_quality=${candidate.opportunityQuality} — idempotent-by-refusal`);
  }

  const compositionRows = await prisma.opportunityCandidateComposition.findMany({ where: { candidateId } });
  const byRole = new Map(compositionRows.map((r) => [r.role, r.nodeId]));
  const marketId = byRole.get("market");
  const audienceId = byRole.get("audience");
  const problemId = byRole.get("problem");
  const hypothesisId = byRole.get("hypothesis");
  const businessModelId = byRole.get("business_model");
  if (!marketId || !audienceId || !problemId || !hypothesisId || !businessModelId) {
    return skip(
      `candidate composition is incomplete — market=${marketId}, audience=${audienceId}, problem=${problemId}, hypothesis=${hypothesisId}, business_model=${businessModelId}`
    );
  }

  const [market, audience, problem, hypothesis, businessModel, config] = await Promise.all([
    prisma.market.findUnique({ where: { id: marketId } }),
    prisma.audience.findUnique({ where: { id: audienceId } }),
    prisma.problem.findUnique({ where: { id: problemId } }),
    prisma.hypothesis.findUnique({ where: { id: hypothesisId } }),
    prisma.businessModel.findUnique({ where: { id: businessModelId } }),
    scoringConfigRepository.latestForVertical(vertical),
  ]);
  if (!market || !audience || !problem || !hypothesis || !businessModel) {
    return skip("one or more composed rows vanished between composition and scoring lookup");
  }
  if (!config) return skip(`no scoring_config found for vertical=${vertical}`);

  const maturityStage = market.maturityStage as ScoringInputs["market"]["maturityStage"];
  const inputs: ScoringInputs = {
    market: {
      growthRateEstimate: market.growthRateEstimate,
      maturityStage,
    },
    audience: {
      willingnessToPaySignal: audience.willingnessToPaySignal,
      acquisitionChannelsKnown: audience.acquisitionChannelsKnown,
    },
    problem: {
      severitySignal: problem.severitySignal,
      frequencySignal: problem.frequencySignal,
    },
    hypothesis: {
      validationScore: hypothesis.validationScore,
      supportingEvidenceStrength: hypothesis.supportingEvidenceStrength,
    },
    businessModel: {
      marginProfile: businessModel.marginProfile,
      operationalComplexityEstimate: businessModel.operationalComplexityEstimate,
      capitalIntensityEstimate: businessModel.capitalIntensityEstimate,
    },
  };
  const weights: ScoringConfigWeights = {
    w1Demand: config.w1Demand,
    w2Hypothesis: config.w2Hypothesis,
    w3Margin: config.w3Margin,
    w4Feasibility: config.w4Feasibility,
    w5Distribution: config.w5Distribution,
    w6Timing: config.w6Timing,
  };

  return agentExecutionLogService.run(
    { runId, agentName: "Scoring", candidateId, modelUsed: null },
    async () => {
      const output = computeOpportunityQuality(inputs, weights);
      await prisma.opportunityCandidate.update({
        where: { id: candidateId },
        data: { opportunityQuality: output.opportunityQuality },
      });
      return {
        opportunityQuality: output.opportunityQuality,
        subScores: output.subScores,
        scoringConfigVersion: config.version,
        skipped: false,
      };
    },
    (result) => ({ graphMutationCount: result.skipped ? 0 : 1 })
  );
}

function skip(reason: string): ScoringRunResult {
  return {
    opportunityQuality: null,
    subScores: null,
    scoringConfigVersion: null,
    skipped: true,
    skipReason: reason,
  };
}
