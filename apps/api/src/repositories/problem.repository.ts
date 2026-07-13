// Expansion Agent's write target (AI_AGENTS.md §2, §18.1 — owns: problem).
import { prisma } from "../db/client";

export interface CreateProblemInput {
  label: string;
  problemMaturity: "unrecognized" | "recognized_unsolved" | "partially_solved";
  currentWorkaroundDescription: string | null;
  severitySignal: number | null;
  frequencySignal: number | null;
  pipelineRunId: string;
}

// Derive confidence from observable-proxy signals. Average when both are
// present; use whichever signal is non-null; fall back to 0.6 when neither
// is available. The 0.6 base reflects that a problem node is only ever
// created from review_complaint evidence — its existence in user reviews
// is itself weak evidence the problem is real, even without a quantifiable
// severity or frequency proxy.
function deriveConfidence(s: number | null, f: number | null): number {
  if (s !== null && f !== null) return (s + f) / 2;
  if (s !== null) return s;
  if (f !== null) return f;
  return 0.6;
}

export const problemRepository = {
  create(input: CreateProblemInput) {
    return prisma.problem.create({
      data: {
        label: input.label,
        problemMaturity: input.problemMaturity,
        currentWorkaroundDescription: input.currentWorkaroundDescription,
        severitySignal: input.severitySignal,
        frequencySignal: input.frequencySignal,
        confidence: deriveConfidence(input.severitySignal, input.frequencySignal),
        pipelineRunId: input.pipelineRunId,
        status: "active",
      },
    });
  },
};
