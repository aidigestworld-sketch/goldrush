// Wraps agent_execution_log's start/complete lifecycle, plus the
// per-candidate branch-join check AGENT_EXECUTION_DAG.md §5.1 needs.
// `run()` is the shape every future agent stage (Phase 3+) should be
// called through, so the log is never forgotten or left dangling on
// an unhandled throw.
import { agentExecutionLogRepository } from "../repositories/agentExecutionLog.repository";

export interface RunAgentStageInput {
  runId: string | null;
  agentName: string;
  candidateId?: string | null;
  modelUsed?: string | null;
  inputHash?: string | null;
  attemptNumber?: number;
}

export class AgentExecutionLogService {
  async start(input: RunAgentStageInput) {
    return agentExecutionLogRepository.create(input);
  }

  async succeed(
    logId: string,
    result: { outputHash?: string | null; costEstimate?: number | null; graphMutationCount?: number | null } = {}
  ) {
    return agentExecutionLogRepository.complete(logId, { status: "success", ...result });
  }

  async fail(logId: string) {
    return agentExecutionLogRepository.complete(logId, { status: "failed" });
  }

  async retry(logId: string) {
    return agentExecutionLogRepository.complete(logId, { status: "retried" });
  }

  // AGENT_EXECUTION_DAG.md §5.1 — is this candidate branch-ready for
  // a given agent (e.g. has Confidence [Mode 2] succeeded for it)?
  async hasSucceeded(runId: string, candidateId: string, agentName: string) {
    return agentExecutionLogRepository.hasSucceeded(runId, candidateId, agentName);
  }

  // Convenience wrapper: start a log entry, run `fn`, mark success or
  // failure automatically based on whether it throws. Future agent
  // implementations (Phase 3+) should call their logic through this
  // rather than managing start/complete calls by hand — that's how
  // "every agent execution must log" (AI_AGENTS.md §20, carried over
  // from the rejected NVIDIA draft's one surviving idea) actually gets
  // enforced in practice, not just stated as a rule.
  //
  // BUG FOUND DURING PHASE 4 LIVE RUN: this originally called
  // `this.succeed(log.id)` with no metrics at all, so
  // agent_execution_log.graph_mutation_count was always NULL even
  // when an agent genuinely wrote rows (Discovery's first live run
  // created 3 Market rows and this column still came back NULL).
  // Fixed with an optional metrics extractor — callers that care about
  // reporting mutation counts pass one; callers that don't can omit it
  // and keep the old (NULL) behavior rather than being forced to change.
  async run<T>(
    input: RunAgentStageInput,
    fn: () => Promise<T>,
    extractMetrics?: (result: T) => {
      outputHash?: string | null;
      costEstimate?: number | null;
      graphMutationCount?: number | null;
    }
  ): Promise<T> {
    const log = await this.start(input);
    try {
      const result = await fn();
      const metrics = extractMetrics ? extractMetrics(result) : {};
      await this.succeed(log.id, metrics);
      return result;
    } catch (err) {
      await this.fail(log.id);
      throw err;
    }
  }
}

export const agentExecutionLogService = new AgentExecutionLogService();
