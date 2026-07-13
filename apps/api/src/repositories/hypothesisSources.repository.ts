// hypothesis_sources — the (Problem, ExistingSolution) hyperedge
// Hypothesis Agent writes alongside a new Hypothesis row
// (GRAPH_SCHEMA.md §3, DATABASE_SCHEMA.md §6.2 — surrogate id + two
// partial unique indexes, existing_solution_id genuinely nullable for
// "cites an absence of solution coverage").
import { prisma } from "../db/client";

export const hypothesisSourcesRepository = {
  create(hypothesisId: string, problemId: string, existingSolutionId: string | null) {
    return prisma.hypothesisSource.create({
      data: { hypothesisId, problemId, existingSolutionId },
    });
  },
};
