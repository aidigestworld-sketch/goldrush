// pipeline_search_log write access — Data Pipeline's audit trail for
// active-search invocations (migration 004). This satisfies
// AI_AGENTS.md §6's "log an explicit 'no further sources available'
// result" invariant with a persisted row per search attempt,
// including the zero-result case (result_count=0 is a valid,
// meaningful row).
//
// Insert-only for MVP: the log is append-only by convention (no
// UPDATE/DELETE trigger like outcome's, because searches are far less
// consequential — losing one row via bad app code isn't a
// correctness issue the way losing an Outcome would be — but the
// semantic is the same: append, don't rewrite).
import { prisma } from "../db/client";

export interface CreatePipelineSearchLogInput {
  runId: string;
  hypothesisId: string | null;
  connector: string;
  queryText: string;
  resultCount: number;
  executedAt: Date;
}

export const pipelineSearchLogRepository = {
  create(input: CreatePipelineSearchLogInput) {
    return prisma.pipelineSearchLog.create({
      data: {
        runId: input.runId,
        hypothesisId: input.hypothesisId,
        connector: input.connector,
        queryText: input.queryText,
        resultCount: input.resultCount,
        executedAt: input.executedAt,
      },
    });
  },
};
