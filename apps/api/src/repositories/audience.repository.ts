// Expansion Agent's write target (AI_AGENTS.md §2, §18.1 — owns: audience).
import { prisma } from "../db/client";

export interface CreateAudienceInput {
  label: string;
  description: string | null;
  pipelineRunId: string;
}

export const audienceRepository = {
  create(input: CreateAudienceInput) {
    return prisma.audience.create({
      data: {
        label: input.label,
        demographicProfile: input.description ? { description: input.description } : undefined,
        pipelineRunId: input.pipelineRunId,
        status: "active",
      },
    });
  },
};
