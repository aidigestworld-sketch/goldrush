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
    result: {
      outputHash?: string | null;
      costEstimate?: number | null;
      graphMutationCount?: number | null;
      rawOutput?: string | null;
    } = {}
  ) {
    return agentExecutionLogRepository.complete(logId, { status: "success", ...result });
  }

  async fail(logId: string, result: { rawOutput?: string | null } = {}) {
    // Persist raw output even on failure — this is where triage most
    // needs it (e.g. Discovery threw because parsed.markets was empty
    // and the retry-on-empty logic decided to fail loudly).
    return agentExecutionLogRepository.complete(logId, { status: "failed", ...result });
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
  // fn receives a `RunContext` it can use to attach observability data
  // (currently: raw LLM output) that isn't part of the returned business
  // value. This keeps agent return types clean while still capturing the
  // raw response for post-hoc triage (added in response to the ba923046
  // Discovery-returned-zero-markets incident where we had no way to
  // inspect the actual LLM output).
  async run<T>(
    input: RunAgentStageInput,
    fn: (ctx: RunContext) => Promise<T>,
    extractMetrics?: (result: T) => {
      outputHash?: string | null;
      costEstimate?: number | null;
      graphMutationCount?: number | null;
    }
  ): Promise<T> {
    const log = await this.start(input);
    const ctx = newRunContext();
    try {
      const result = await fn(ctx);
      const metrics = extractMetrics ? extractMetrics(result) : {};
      await this.succeed(log.id, { ...metrics, rawOutput: ctx.rawOutput });
      return result;
    } catch (err) {
      await this.fail(log.id, { rawOutput: ctx.rawOutput });
      throw err;
    }
  }
}

// Mutable box the agent's fn writes to. Not exported directly — created
// per-invocation inside `run()` and passed in as the fn's argument.
export interface RunContext {
  setRawOutput: (raw: string | null | undefined) => void;
  readonly rawOutput: string | null;
}

function newRunContext(): RunContext & { rawOutput: string | null } {
  const box: { rawOutput: string | null } = { rawOutput: null };
  return {
    setRawOutput(raw) {
      box.rawOutput = raw ?? null;
    },
    get rawOutput() {
      return box.rawOutput;
    },
  };
}

export const agentExecutionLogService = new AgentExecutionLogService();
