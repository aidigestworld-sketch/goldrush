// Thin wrapper around Prisma for agent_execution_log.
// No status-lifecycle rules here — that's AgentExecutionLogService.
import { prisma } from "../db/client";

export interface StartExecutionInput {
  runId: string | null;
  agentName: string;
  candidateId?: string | null;   // null for pre-Composition stages, AGENT_EXECUTION_DAG.md §2
  modelUsed?: string | null;     // null for deterministic agents
  inputHash?: string | null;
  attemptNumber?: number;
}

export interface CompleteExecutionInput {
  status: "success" | "failed" | "retried";
  outputHash?: string | null;
  costEstimate?: number | null;
  graphMutationCount?: number | null;
}

export const agentExecutionLogRepository = {
  create(input: StartExecutionInput) {
    return prisma.agentExecutionLog.create({
      data: {
        runId: input.runId,
        candidateId: input.candidateId ?? null,
        agentName: input.agentName,
        modelUsed: input.modelUsed ?? null,
        inputHash: input.inputHash ?? null,
        startedAt: new Date(),
        status: "running",
        attemptNumber: input.attemptNumber ?? 1,
      },
    });
  },

  complete(id: string, input: CompleteExecutionInput) {
    return prisma.agentExecutionLog.update({
      where: { id },
      data: {
        status: input.status,
        outputHash: input.outputHash ?? null,
        costEstimate: input.costEstimate ?? null,
        graphMutationCount: input.graphMutationCount ?? null,
        completedAt: new Date(),
      },
    });
  },

  findById(id: string) {
    return prisma.agentExecutionLog.findUnique({ where: { id } });
  },

  // Used by AGENT_EXECUTION_DAG.md §5.1's per-candidate branch-join
  // check: has this agent succeeded for this (runId, candidateId)?
  hasSucceeded(runId: string, candidateId: string, agentName: string) {
    return prisma.agentExecutionLog
      .findFirst({
        where: { runId, candidateId, agentName, status: "success" },
        select: { id: true },
      })
      .then((row) => row !== null);
  },
};
