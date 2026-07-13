// Run lifecycle rules for pipeline_run — the "no partial output"
// invariant (AI_AGENTS.md §13, AGENT_EXECUTION_DAG.md §4) lives here,
// not in the repository. This does NOT yet implement the DAG
// execution itself (Phase 6, AI_AGENTS.md §17) — it only exposes the
// state transitions a future Orchestrator will drive.
import { pipelineRunRepository } from "../repositories/pipelineRun.repository";

export class PipelineRunService {
  async start(founderId: string, vertical: string) {
    return pipelineRunRepository.create({ founderId, vertical });
  }

  async get(runId: string) {
    const run = await pipelineRunRepository.findById(runId);
    if (!run) {
      throw new Error(`pipeline_run ${runId} not found`);
    }
    return run;
  }

  async advanceStage(runId: string, nextStage: string) {
    const run = await this.get(runId);
    if (run.status !== "running") {
      // Matches AGENT_EXECUTION_DAG.md §4: a run that already reached
      // a terminal state must not silently keep advancing.
      throw new Error(
        `cannot advance stage on run ${runId} — status is "${run.status}", not "running"`
      );
    }
    return pipelineRunRepository.updateStage(runId, nextStage);
  }

  async complete(runId: string) {
    return pipelineRunRepository.markCompleted(runId);
  }

  async fail(runId: string, reason: string) {
    // No partial Opportunity is ever produced — AI_AGENTS.md §13's
    // invariant. This method only records the failure state; it is
    // the Orchestrator's job (not built yet) to ensure nothing else
    // committed alongside it.
    return pipelineRunRepository.markFailed(runId, reason);
  }

  async markInsufficientEvidence(runId: string) {
    // A distinct, non-error outcome — AGENT_EXECUTION_DAG.md §4: every
    // stage ran successfully, but no candidate survived to Compression.
    return pipelineRunRepository.markInsufficientEvidence(runId);
  }
}

export const pipelineRunService = new PipelineRunService();
