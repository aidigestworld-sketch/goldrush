// Real CompetitiveAnalysis Agent — Phase 4. Reads competitor_material
// Evidence for a given active Problem, calls the LLM using
// competitiveAnalysisSandbox.ts's validated prompt/schema/grounding
// checks, writes ExistingSolution + BusinessModel +
// addressed_by/competes_with/monetizes_via edges (AI_AGENTS.md §4/§18.1
// — Gap 6 fix: this agent owns business_model, not just existing_solution).
//
// Same per-target scoping note as expansionAgent.ts: takes a single
// problemId; fanning out across every active Problem is the
// Orchestrator's job, not this agent's.
import {
  runCompetitiveAnalysisSandbox,
  type CompetitiveAnalysisInputDocument,
} from "../../sandbox/competitiveAnalysisSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { existingSolutionRepository } from "../../repositories/existingSolution.repository";
import { businessModelRepository } from "../../repositories/businessModel.repository";
import { nodeSourceRefRepository } from "../../repositories/nodeSourceRef.repository";
import { edgeRepository } from "../../repositories/edge.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

export interface CompetitiveAnalysisRunResult {
  existingSolutionsCreated: number;
  businessModelsCreated: number;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runCompetitiveAnalysisAgent(
  runId: string,
  problemId: string,
  competitorNamesToEvidenceIds: Map<string, string[]>, // which evidence rows belong to which named competitor
  llm: LLMClient
): Promise<CompetitiveAnalysisRunResult> {
  const problem = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!problem || problem.status !== "active") {
    return {
      existingSolutionsCreated: 0,
      businessModelsCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `problem ${problemId} not found or not active`,
    };
  }

  const allEvidenceIds = [...competitorNamesToEvidenceIds.values()].flat();
  if (allEvidenceIds.length === 0) {
    return {
      existingSolutionsCreated: 0,
      businessModelsCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: "no competitor_material evidence provided for this problem — run Phase 2 ingestion first",
    };
  }

  const evidenceRows = await prisma.evidence.findMany({
    where: { id: { in: allEvidenceIds }, sourceType: "competitor_material", status: "active" },
  });

  const evidenceToCompetitor = new Map<string, string>();
  for (const [name, ids] of competitorNamesToEvidenceIds) {
    for (const id of ids) evidenceToCompetitor.set(id, name);
  }

  const documents: CompetitiveAnalysisInputDocument[] = evidenceRows.map((e) => ({
    id: e.id,
    competitorName: evidenceToCompetitor.get(e.id) ?? "unknown",
    sourceType: "competitor_material" as const,
    text: e.extractedFact,
  }));

  return agentExecutionLogService.run(
    { runId, agentName: "CompetitiveAnalysis", modelUsed: (llm as { model?: string }).model ?? null },
    async () => {
      const result = await runCompetitiveAnalysisSandbox(llm, documents);

      if (!result.parsed) {
        throw new Error(`CompetitiveAnalysis Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          existingSolutionsCreated: 0,
          businessModelsCreated: 0,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      const createdSolutionIds: string[] = [];
      for (const solution of result.parsed.existing_solutions) {
        const created = await existingSolutionRepository.create({
          label: solution.label,
          positioningSummary: solution.positioning_summary,
          positioningSummaryIsCompetitorStated: solution.positioning_summary_is_competitor_stated,
          pricingModel: solution.pricing_summary ? { summary: solution.pricing_summary } : null,
          strengths: solution.strengths,
          weaknesses: solution.weaknesses,
          pipelineRunId: runId,
        });
        await nodeSourceRefRepository.createMany(
          solution.evidence_refs.map((evidenceId) => ({ nodeId: created.id, nodeType: "existing_solution" as const, evidenceId }))
        );
        await edgeRepository.create("addressed_by", problem.id, "problem", created.id, "existing_solution");
        createdSolutionIds.push(created.id);
      }

      // competes_with: pairwise between every solution addressing this
      // same Problem — competitors targeting the same problem compete
      // with each other, by construction of this scoping.
      for (let i = 0; i < createdSolutionIds.length; i++) {
        for (let j = i + 1; j < createdSolutionIds.length; j++) {
          await edgeRepository.create("competes_with", createdSolutionIds[i], "existing_solution", createdSolutionIds[j], "existing_solution");
        }
      }

      let businessModelsCreated = 0;
      for (const bm of result.parsed.business_models) {
        const created = await businessModelRepository.create({ label: bm.competitor_label, modelType: bm.model_type, pipelineRunId: runId });
        await nodeSourceRefRepository.createMany(
          bm.evidence_refs.map((evidenceId) => ({ nodeId: created.id, nodeType: "business_model" as const, evidenceId }))
        );
        // Link this business model to the matching existing_solution by label
        const matchingSolutionIdx = result.parsed.existing_solutions.findIndex((s) => s.label === bm.competitor_label);
        if (matchingSolutionIdx >= 0) {
          await edgeRepository.create(
            "monetizes_via",
            createdSolutionIds[matchingSolutionIdx],
            "existing_solution",
            created.id,
            "business_model"
          );
        }
        businessModelsCreated++;
      }

      return {
        existingSolutionsCreated: createdSolutionIds.length,
        businessModelsCreated,
        boundedRuleViolations: [],
        skipped: false,
      };
    },
    (result) => ({ graphMutationCount: result.existingSolutionsCreated + result.businessModelsCreated })
  );
}
