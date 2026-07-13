// Thin wrapper around Prisma for the pipeline_run table.
// No business logic here — that lives in PipelineRunService.
import { prisma } from "../db/client";
import type { Prisma } from "@prisma/client";

export interface CreatePipelineRunInput {
  founderId: string;
  vertical: string;
}

export const pipelineRunRepository = {
  create(input: CreatePipelineRunInput) {
    return prisma.pipelineRun.create({
      data: {
        founderId: input.founderId,
        vertical: input.vertical,
        // currentStage/status use their DB defaults ('discovery' / 'running')
      },
    });
  },

  findById(runId: string) {
    return prisma.pipelineRun.findUnique({ where: { runId } });
  },

  updateStage(runId: string, currentStage: string) {
    return prisma.pipelineRun.update({
      where: { runId },
      data: { currentStage },
    });
  },

  markCompleted(runId: string) {
    return prisma.pipelineRun.update({
      where: { runId },
      data: { status: "completed", completedAt: new Date() },
    });
  },

  markFailed(runId: string, failureReason: string) {
    return prisma.pipelineRun.update({
      where: { runId },
      data: { status: "failed", failureReason, completedAt: new Date() },
    });
  },

  markInsufficientEvidence(runId: string) {
    return prisma.pipelineRun.update({
      where: { runId },
      data: { status: "insufficient_evidence", completedAt: new Date() },
    });
  },

  // Exposed for services that need to compose these calls inside a
  // larger transaction (e.g. stage writes + stage-advance committing
  // together, per AGENT_EXECUTION_DAG.md §4) — takes a transaction
  // client instead of the module-level singleton.
  withTx(tx: Prisma.TransactionClient) {
    return {
      updateStage: (runId: string, currentStage: string) =>
        tx.pipelineRun.update({ where: { runId }, data: { currentStage } }),
    };
  },
};
