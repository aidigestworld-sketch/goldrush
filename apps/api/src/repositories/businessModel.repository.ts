// CompetitiveAnalysis Agent's write target — Gap 6 fix from AI_AGENTS.md
// §0/§4 (previously no agent explicitly owned business_model creation).
import { prisma } from "../db/client";

export interface CreateBusinessModelInput {
  label: string;
  modelType: string;
  pipelineRunId: string;
}

export const businessModelRepository = {
  create(input: CreateBusinessModelInput) {
    return prisma.businessModel.create({
      data: {
        label: input.label,
        modelType: input.modelType,
        pipelineRunId: input.pipelineRunId,
        status: "active",
      },
    });
  },
};
