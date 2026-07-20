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
import { selectWithinTokenBudget, getInputTokenBudgetForModel } from "../../sandbox/tokenBudget";

export interface ExpansionRunResult {
  audiencesCreated: number;
  problemsCreated: number;
  // Count of experiences edges (audience → problem) written this run.
  // Non-zero on the happy path — a zero here on a non-skipped run
  // means Composition will not be able to satisfy its 5-role invariant
  // (see compositionAgent.ts:122's audience-lookup path).
  experiencesEdgesCreated: number;
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
      experiencesEdgesCreated: 0,
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
      experiencesEdgesCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `no active review_complaint evidence for vertical=${run.vertical} — run Phase 2 ingestion first`,
    };
  }

  // Token-budget selection — same pattern as Discovery. Expansion's input
  // is a single source_type (review_complaint), so the selector reduces to
  // recency + id ordering — the newest N complaints fit under the budget,
  // older ones are dropped. Prevents the same class of 128K-context overflow
  // Discovery hit on 07:34 UTC 2026-07-15 from surfacing here as
  // review_complaint corpora grow.
  const budgetResult = selectWithinTokenBudget(
    evidenceRows.map((e) => ({
      id: e.id,
      sourceType: "review_complaint",
      text: e.extractedFact,
      recencyAt: e.sourcePublishedAt ?? e.fetchedAt ?? null,
    })),
    getInputTokenBudgetForModel((llm as { model?: string }).model)
  );
  if (budgetResult.droppedCount > 0) {
    console.warn(
      `[Expansion] token-budget: kept ${budgetResult.selected.length}/${evidenceRows.length} evidence rows ` +
        `(~${budgetResult.totalTokensEstimated} tokens, budget=${budgetResult.budgetTokens}), ` +
        `dropped by source_type: ${JSON.stringify(budgetResult.droppedBySourceType)}`
    );
  }

  const documents: ExpansionInputDocument[] = budgetResult.selected.map((e) => ({
    id: e.id,
    sourceType: "review_complaint" as const,
    text: e.text,
  }));

  return agentExecutionLogService.run(
    { runId, agentName: "Expansion", modelUsed: (llm as { model?: string }).model ?? null },
    async (ctx) => {
      const result = await runExpansionSandbox(llm, documents, market.label ?? run.vertical);
      ctx.setRawOutput(result.rawResponse);

      if (!result.parsed) {
        throw new Error(`Expansion Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          audiencesCreated: 0,
          problemsCreated: 0,
          experiencesEdgesCreated: 0,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      // Build labelToAudienceId as we create audiences so the problem
      // loop below can resolve experiencing_audience_labels back to real
      // DB ids. audienceRepository.create returns the row, so this is
      // one map insert per audience — no extra query.
      const audienceIdByLabel = new Map<string, string>();
      let audiencesCreated = 0;
      for (const audience of result.parsed.audiences) {
        const created = await audienceRepository.create({ label: audience.label, description: audience.description, pipelineRunId: runId });
        audienceIdByLabel.set(audience.label, created.id);
        await nodeSourceRefRepository.createMany(
          audience.evidence_refs.map((evidenceId) => ({ nodeId: created.id, nodeType: "audience" as const, evidenceId }))
        );
        await edgeRepository.create("has_audience", market.id, "market", created.id, "audience");
        audiencesCreated++;
      }

      let problemsCreated = 0;
      // Track how many problems fell back to Cartesian (LLM omitted
      // experiencing_audience_labels) so operators can see whether the
      // model is learning to populate the field or whether we're always
      // paying for the safe default. Not a BRV — the fallback IS the
      // safe path — just a warn line.
      let experiencesFallbackCount = 0;
      let experiencesEdgesCreated = 0;
      const allAudienceIds = [...audienceIdByLabel.values()];
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

        // experiences edges (audience → problem). This is the fix
        // for the gap Composition documented at compositionAgent.ts:122
        // — without these edges, Composition's audience-lookup returns
        // empty and every downstream candidate slot goes empty, which
        // was silently forcing every run to insufficient_evidence
        // regardless of hypothesis strength (observed on run
        // d84f73a7 on 2026-07-16: 0 candidate rows despite a
        // validation_score=0.82 hypothesis).
        //
        // Resolution:
        //   1. If the model supplied experiencing_audience_labels
        //      (new schema field), resolve each to an audience id and
        //      write the edges. Sandbox has already BRV-rejected
        //      hallucinated labels.
        //   2. Otherwise, fall back to writing an edge to EVERY
        //      audience the model emitted for this market — a safe
        //      conservative default (all extracted audiences are the
        //      pool the model considered for this market's problems).
        //      Warn so we can watch how often this fires.
        let audienceIdsForProblem: string[];
        if (problem.experiencing_audience_labels && problem.experiencing_audience_labels.length > 0) {
          audienceIdsForProblem = problem.experiencing_audience_labels
            .map((label) => audienceIdByLabel.get(label))
            .filter((id): id is string => id !== undefined);
        } else {
          audienceIdsForProblem = allAudienceIds;
          experiencesFallbackCount++;
        }
        for (const audienceId of audienceIdsForProblem) {
          await edgeRepository.create("experiences", audienceId, "audience", created.id, "problem");
          experiencesEdgesCreated++;
        }

        problemsCreated++;
      }
      if (experiencesFallbackCount > 0) {
        console.warn(
          `[Expansion] experiencing_audience_labels fallback used for ${experiencesFallbackCount}/${result.parsed.problems.length} problems ` +
            `(model omitted the field; linked to all ${allAudienceIds.length} audiences for market ${market.id})`
        );
      }

      return {
        audiencesCreated,
        problemsCreated,
        experiencesEdgesCreated,
        boundedRuleViolations: [],
        skipped: false,
      };
    },
    // graphMutationCount tallies node inserts + the new experiences
    // edges (has_audience is 1 per audience, already reflected in
    // audiencesCreated's downstream count of created rows; experiences
    // is a new class of write introduced by the audience↔problem
    // linkage fix and needs its own tally so the audit log reflects
    // actual write volume).
    (result) => ({
      graphMutationCount:
        result.audiencesCreated + result.problemsCreated + result.experiencesEdgesCreated,
    })
  );
}
