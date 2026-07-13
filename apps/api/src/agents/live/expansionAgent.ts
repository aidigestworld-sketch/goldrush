// Real Expansion Agent — Phase 4. Reads review/complaint Evidence for
// a given active Market, calls the LLM using expansionSandbox.ts's
// validated prompt/schema/grounding-check, writes Audience + Problem +
// has_audience/experiences edges. Nothing else (AI_AGENTS.md §2/§18.1).
//
// NOTE on scope: takes a single marketId rather than looping over
// every active Market — full fan-out across all active markets is the
// Orchestrator's job (Phase 6, AI_AGENTS.md §17's DAG execution), not
// this agent's own concern. This function is the per-market unit of
// work the Orchestrator will eventually call once per active Market.
import { runExpansionSandbox, type ExpansionInputDocument } from "../../sandbox/expansionSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { audienceRepository } from "../../repositories/audience.repository";
import { problemRepository } from "../../repositories/problem.repository";
import { nodeSourceRefRepository } from "../../repositories/nodeSourceRef.repository";
import { edgeRepository } from "../../repositories/edge.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

export interface ExpansionRunResult {
  audiencesCreated: number;
  problemsCreated: number;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runExpansionAgent(runId: string, marketId: string, llm: LLMClient): Promise<ExpansionRunResult> {
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market || market.status !== "active") {
    return {
      audiencesCreated: 0,
      problemsCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `market ${marketId} not found or not active`,
    };
  }

  const run = await prisma.pipelineRun.findUnique({ where: { runId } });
  if (!run) throw new Error(`pipeline_run ${runId} not found`);

  const evidenceRows = await prisma.evidence.findMany({
    where: { sourceType: "review_complaint", status: "active", vertical: run.vertical },
  });

  if (evidenceRows.length === 0) {
    return {
      audiencesCreated: 0,
      problemsCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `no active review_complaint evidence for vertical=${run.vertical} — run Phase 2 ingestion first`,
    };
  }

  const documents: ExpansionInputDocument[] = evidenceRows.map((e) => ({
    id: e.id,
    sourceType: "review_complaint" as const,
    text: e.extractedFact,
  }));

  return agentExecutionLogService.run(
    { runId, agentName: "Expansion", modelUsed: (llm as { model?: string }).model ?? null },
    async () => {
      const result = await runExpansionSandbox(llm, documents, market.label ?? run.vertical);

      if (!result.parsed) {
        throw new Error(`Expansion Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          audiencesCreated: 0,
          problemsCreated: 0,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      let audiencesCreated = 0;
      for (const audience of result.parsed.audiences) {
        const created = await audienceRepository.create({ label: audience.label, description: audience.description, pipelineRunId: runId });
        await nodeSourceRefRepository.createMany(
          audience.evidence_refs.map((evidenceId) => ({ nodeId: created.id, nodeType: "audience" as const, evidenceId }))
        );
        await edgeRepository.create("has_audience", market.id, "market", created.id, "audience");
        audiencesCreated++;
      }

      let problemsCreated = 0;
      for (const problem of result.parsed.problems) {
        const created = await problemRepository.create({
          label: problem.label,
          problemMaturity: problem.problem_maturity,
          currentWorkaroundDescription: problem.current_workaround_description,
          severitySignal: problem.severity_signal,
          frequencySignal: problem.frequency_signal,
          pipelineRunId: runId,
        });
        await nodeSourceRefRepository.createMany(
          problem.evidence_refs.map((evidenceId) => ({ nodeId: created.id, nodeType: "problem" as const, evidenceId }))
        );
        problemsCreated++;
      }

      return { audiencesCreated, problemsCreated, boundedRuleViolations: [], skipped: false };
    },
    (result) => ({ graphMutationCount: result.audiencesCreated + result.problemsCreated })
  );
}
