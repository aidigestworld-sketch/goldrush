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
  // Raw LLM response text (nullable — deterministic agents have no
  // raw output). Capped at RAW_OUTPUT_MAX_BYTES in `complete` so a
  // jumbo completion doesn't bloat the table.
  rawOutput?: string | null;
}

// 50KB. Discovery / Expansion / CompetitiveAnalysis routinely emit
// multi-KB structured markets[] / problems[] / solutions[] arrays;
// 50KB fits normal completions whole and keeps enough of a truncated
// payload to reason about what happened. Table size cost per row is
// bounded by this cap.
export const RAW_OUTPUT_MAX_BYTES = 50_000;

function capRawOutput(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw.length <= RAW_OUTPUT_MAX_BYTES) return raw;
  return raw.slice(0, RAW_OUTPUT_MAX_BYTES) + `\n\n[...truncated at ${RAW_OUTPUT_MAX_BYTES} chars; original was ${raw.length} chars]`;
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
        rawOutput: capRawOutput(input.rawOutput),
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
