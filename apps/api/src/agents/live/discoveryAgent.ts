// Real Discovery Agent — Phase 4. Reads real Evidence rows (source
// types search_signal/marketplace/industry_report/financial_signal
// only, per AI_AGENTS.md §1), calls a real LLM (NIM in production;
// the same prompt/schema already validated in discoverySandbox.ts),
// and writes Market + node_source_refs — nothing else, per the
// Write Scope Matrix (AI_AGENTS.md §15/§18.1).
//
// This reuses discoverySandbox.ts's exact prompt/Zod-schema/Bounded-
// Rule-checking logic rather than duplicating it — the sandbox WAS
// the spec-validation step; this is that same validated logic wired
// to real reads/writes instead of fixture-in, console-out.
import { runDiscoverySandbox, type DiscoveryInputDocument } from "../../sandbox/discoverySandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { marketRepository } from "../../repositories/market.repository";
import { nodeSourceRefRepository } from "../../repositories/nodeSourceRef.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

const ALLOWED_SOURCE_TYPES = ["search_signal", "marketplace", "industry_report", "financial_signal"] as const;

export interface DiscoveryRunResult {
  marketsCreated: number;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runDiscoveryAgent(runId: string, llm: LLMClient): Promise<DiscoveryRunResult> {
  // Load the run to know which vertical to scope evidence to. Every
  // pipeline_run.vertical is set on run creation; Discovery reading
  // outside its vertical is the specific bug migration 008 exists to fix.
  const run = await prisma.pipelineRun.findUnique({ where: { runId } });
  if (!run) throw new Error(`pipeline_run ${runId} not found`);

  // AI_AGENTS.md §1: input is normalized Data Pipeline records of the
  // allowed source types ONLY — never review_complaint/competitor_material.
  // Scoped to this run's vertical per migration 008 — Evidence with a
  // null vertical (unclassified) is defensively excluded so it can't
  // silently leak into any run.
  const evidenceRows = await prisma.evidence.findMany({
    where: {
      sourceType: { in: [...ALLOWED_SOURCE_TYPES] },
      status: "active",
      vertical: run.vertical,
    },
  });

  if (evidenceRows.length === 0) {
    return {
      marketsCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason:
        "no active evidence of an allowed source_type exists — Phase 2's connectors don't yet cover " +
        "search_signal/marketplace/industry_report/financial_signal; see MVP_IMPLEMENTATION_PLAN.md follow-up",
    };
  }

  const documents: DiscoveryInputDocument[] = evidenceRows.map((e) => ({
    id: e.id,
    sourceType: e.sourceType as (typeof ALLOWED_SOURCE_TYPES)[number],
    text: e.extractedFact,
  }));

  return agentExecutionLogService.run(
    { runId, agentName: "Discovery", modelUsed: (llm as { model?: string }).model ?? null },
    async () => {
      const result = await runDiscoverySandbox(llm, documents);

      if (!result.parsed) {
        throw new Error(`Discovery Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }

      // Orchestrator-equivalent enforcement (AI_AGENTS.md §12/§13):
      // reject the whole batch on any Bounded Rule violation rather
      // than silently writing the good ones and ignoring the bad —
      // "no partial output" applies here at the write-gate level too,
      // not just at the run-outcome level Compression handles.
      if (result.boundedRuleViolations.length > 0) {
        return {
          marketsCreated: 0,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written, see boundedRuleViolations",
        };
      }

      let marketsCreated = 0;
      for (const market of result.parsed.markets) {
        const created = await marketRepository.create({
          label: market.label,
          marketSizeEstimate: market.market_size_estimate,
          growthRateEstimate: market.growth_rate_estimate,
          maturityStage: market.maturity_stage,
          categoryTags: market.category_tags,
          confidence: market.confidence,
          pipelineRunId: runId,
        });
        await nodeSourceRefRepository.createMany(
          market.evidence_refs.map((evidenceId) => ({ nodeId: created.id, nodeType: "market" as const, evidenceId }))
        );
        marketsCreated++;
      }

      return { marketsCreated, boundedRuleViolations: [], skipped: false };
    },
    (result) => ({ graphMutationCount: result.marketsCreated })
  );
}
