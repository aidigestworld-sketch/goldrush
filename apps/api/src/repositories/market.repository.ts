// Discovery Agent's exclusive write target (AI_AGENTS.md §1, §18.1 —
// owns: market). No other agent may write to this table.
import { prisma } from "../db/client";

export interface CreateMarketInput {
  label: string;
  marketSizeEstimate: number | null;
  growthRateEstimate: number | null;
  maturityStage: "emerging" | "growing" | "mature" | "declining";
  categoryTags: string[];
  confidence: number;
  // The pipeline_run that produced this node. Required going forward
  // — see migration 009's header. Nullable in the column for backfill
  // compatibility, but every new write from an agent MUST supply it.
  pipelineRunId: string;
}

export const marketRepository = {
  create(input: CreateMarketInput) {
    return prisma.market.create({
      data: {
        label: input.label,
        marketSizeEstimate: input.marketSizeEstimate,
        growthRateEstimate: input.growthRateEstimate,
        maturityStage: input.maturityStage,
        categoryTags: input.categoryTags,
        confidence: input.confidence,
        pipelineRunId: input.pipelineRunId,
        status: "active", // Discovery MUST NOT set any other status — AI_AGENTS.md §1 invariant
      },
    });
  },

  // Run-scoped. runFilteringAgent and runExpansionAgent use this to
  // avoid cross-run contamination — see migration 009.
  findActiveByRun(pipelineRunId: string) {
    return prisma.market.findMany({ where: { status: "active", pipelineRunId } });
  },
};
