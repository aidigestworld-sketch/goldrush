// CompetitiveAnalysis Agent's write target (AI_AGENTS.md §4, §18.1).
import { prisma } from "../db/client";

export interface CreateExistingSolutionInput {
  label: string;
  positioningSummary: string | null;
  // Whether positioningSummary is the competitor's own stated
  // position vs. a third party's opinion about them — was previously
  // computed by the sandbox and then silently discarded before
  // reaching Postgres (found during CompetitiveAnalysis's first live
  // run, 002_existing_solution_attribution_flag.sql). null = not
  // evaluated; never default this to false on the caller's behalf.
  positioningSummaryIsCompetitorStated: boolean | null;
  // Narrowed to the actual shape competitiveAnalysisAgent.ts constructs
  // ({ summary: solution.pricing_summary } or null) — the previous
  // `Record<string, unknown> | null` failed Prisma's InputJsonValue
  // check because `unknown` values aren't provably JSON-serializable,
  // even though every real value passed here always was. Caught by
  // `tsc` during Phase 4 delivery, not guessed around.
  pricingModel: { summary: string } | null;
  strengths: string[];
  weaknesses: string[];
  pipelineRunId: string;
}

export const existingSolutionRepository = {
  create(input: CreateExistingSolutionInput) {
    return prisma.existingSolution.create({
      data: {
        label: input.label,
        positioningSummary: input.positioningSummary,
        positioningSummaryIsCompetitorStated: input.positioningSummaryIsCompetitorStated,
        pricingModel: input.pricingModel ?? undefined,
        strengths: input.strengths,
        weaknesses: input.weaknesses,
        pipelineRunId: input.pipelineRunId,
        status: "active",
      },
    });
  },
};


