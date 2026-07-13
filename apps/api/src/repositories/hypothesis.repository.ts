// Hypothesis Agent's write target (AI_AGENTS.md §5, §18.1 — owns: hypothesis).
import { prisma } from "../db/client";

export interface CreateHypothesisInput {
  statement: string;
  gapType: "positioning" | "pricing" | "business_model" | "distribution";
  missingData: string[];
  // Deterministic tier-weighted evidence authority × volume, computed
  // by evidenceStrength.ts from the hypothesis's cited supporting
  // evidence. NOT the LLM's own confidence — that goes in `confidence`
  // below. See evidenceStrength.ts header for the P3.1 audit history
  // that separated the two.
  supportingEvidenceStrength: number | null;
  // LLM-self-reported hypothesis confidence — observability only.
  // Deliberately NOT read by Scoring (opportunity_quality only sees
  // supportingEvidenceStrength + validationScore). Retained so the
  // rationale sandbox and post-hoc analysis can see what the model
  // thought about its own hypothesis, without letting that ungrounded
  // number tilt the score.
  confidence: number | null;
  pipelineRunId: string;
}

export const hypothesisRepository = {
  create(input: CreateHypothesisInput) {
    return prisma.hypothesis.create({
      data: {
        statement: input.statement,
        gapType: input.gapType,
        missingData: input.missingData,
        supportingEvidenceStrength: input.supportingEvidenceStrength,
        confidence: input.confidence,
        pipelineRunId: input.pipelineRunId,
        status: "active",
      },
    });
  },

  findActive() {
    return prisma.hypothesis.findMany({ where: { status: "active" } });
  },

  findById(id: string) {
    return prisma.hypothesis.findUnique({ where: { id } });
  },

  // Validation Agent (Collector)'s ONLY write right on hypothesis
  // (AI_AGENTS.md §18.2 — missing_data is the one co-writable field,
  // shared with Hypothesis Agent). Never touches status or
  // validation_score — those belong exclusively to Confidence Agent.
  appendMissingData(id: string, newItems: string[]) {
    if (newItems.length === 0) return prisma.hypothesis.findUnique({ where: { id } });
    return prisma.hypothesis.update({
      where: { id },
      data: { missingData: { push: newItems } },
    });
  },

  // Confidence Agent (Evaluator), Mode 1 — the SOLE writer of
  // validation_score and validation_computed_at_cluster_version
  // anywhere in the system (AI_AGENTS.md §7, §18.2). No other agent may
  // set these two fields under any circumstance.
  setValidationScore(id: string, score: number, clusterVersion: number | null) {
    return prisma.hypothesis.update({
      where: { id },
      data: {
        validationScore: score,
        validationComputedAtClusterVersion: clusterVersion,
      },
    });
  },

  // Confidence Agent (Evaluator), Mode 1 — the SOLE writer of the
  // failed_validation deprecation transition (AI_AGENTS.md §7 invariant
  // #5, §18.2). Applied when validation_score fails the configured
  // gate threshold. This is a one-way transition here — Memory Agent
  // is the only path back to 'active' (§7 invariant #5).
  markFailedValidation(id: string) {
    return prisma.hypothesis.update({
      where: { id },
      data: {
        status: "deprecated",
        deprecationReason: "failed_validation",
      },
    });
  },
};
