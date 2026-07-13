// Real Filtering Agent — DAG stage 3. AI_AGENTS.md §3. Deterministic
// (no LLM call) — the whole computation lives in ../filtering.ts's
// pure function; this wrapper only does the graph read, applies the
// pure decision function, and commits the deprecations.
//
// DAG POSITION: runs after Expansion (stage 2), before CompetitiveAnalysis
// (stage 4). At that point in a fresh run, Market/Audience/Problem
// exist (Discovery + Expansion have written them) but ExistingSolution/
// BusinessModel do not yet (CompetitiveAnalysis hasn't run) and
// Hypothesis certainly not (stage 5). So this wrapper scopes itself
// to the three node types Filtering can actually see at its DAG
// position — Market, Audience, Problem — and leaves the later-created
// types alone. Running it on later types would either misfire (they
// don't exist yet on a normal DAG traversal) or overreach outside
// stage 3's charter.
//
// Writes ONLY: UPDATE {market,audience,problem} SET status='deprecated',
// deprecation_reason=... on rows below the confidence threshold or
// with NULL confidence. NEVER touches confidence itself, never
// touches other node types, never touches evidence/edges.
//
// Confidence-threshold source: passed in from the caller as
// `minConfidence`. Not a config lookup because scoring_config today
// has no filtering-threshold column — same pragmatic decision as
// confidenceAgent.ts's VALIDATION_GATE_THRESHOLD constant.
import { applyFiltering, type FilterableNode } from "../filtering";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

export const DEFAULT_MIN_CONFIDENCE = 0.5;

export interface FilteringRunResult {
  perType: {
    nodeType: "market" | "audience" | "problem";
    totalConsidered: number;
    deprecated: { id: string; deprecationReason: string }[];
    survived: number;
  }[];
  totalDeprecated: number;
  skipped: boolean;
  skipReason?: string;
}

// Table-driven so each node type's read+write pair is one place;
// same 6-node-type pattern as compositionAgent.ts's filterActiveByType
// helper but limited to the 3 types Filtering is scoped to per the
// DAG header note above.
type ScopedNodeType = "market" | "audience" | "problem";

// Loads only the current run's active nodes of a given type.
// Migration 009 added pipeline_run_id — before this filter, Filtering
// for run A deprecated rows created by run B whenever B's confidence
// happened to be below the threshold. That's a real correctness bug,
// not just noise: the two-run test in this task explicitly asserts
// this no longer happens.
async function loadActive(nodeType: ScopedNodeType, pipelineRunId: string): Promise<FilterableNode[]> {
  if (nodeType === "market") {
    const rows = await prisma.market.findMany({
      where: { status: "active", pipelineRunId },
      select: { id: true, confidence: true },
    });
    return rows.map((r) => ({ id: r.id, confidence: r.confidence }));
  }
  if (nodeType === "audience") {
    const rows = await prisma.audience.findMany({
      where: { status: "active", pipelineRunId },
      select: { id: true, confidence: true },
    });
    return rows.map((r) => ({ id: r.id, confidence: r.confidence }));
  }
  const rows = await prisma.problem.findMany({
    where: { status: "active", pipelineRunId },
    select: { id: true, confidence: true },
  });
  return rows.map((r) => ({ id: r.id, confidence: r.confidence }));
}

async function deprecate(nodeType: ScopedNodeType, id: string, reason: string) {
  const data = { status: "deprecated" as const, deprecationReason: reason };
  if (nodeType === "market") return prisma.market.update({ where: { id }, data });
  if (nodeType === "audience") return prisma.audience.update({ where: { id }, data });
  return prisma.problem.update({ where: { id }, data });
}

export async function runFilteringAgent(
  runId: string,
  options: { minConfidence?: number } = {}
): Promise<FilteringRunResult> {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  return agentExecutionLogService.run(
    { runId, agentName: "Filtering", candidateId: null, modelUsed: null },
    async () => {
      const perType: FilteringRunResult["perType"] = [];
      let totalDeprecated = 0;

      for (const nodeType of ["market", "audience", "problem"] as ScopedNodeType[]) {
        const nodes = await loadActive(nodeType, runId);
        const decisions = applyFiltering(nodes, { minConfidence });
        const deprecated: { id: string; deprecationReason: string }[] = [];
        for (const d of decisions) {
          if (!d.survived) {
            await deprecate(nodeType, d.id, d.deprecationReason!);
            deprecated.push({ id: d.id, deprecationReason: d.deprecationReason! });
          }
        }
        perType.push({
          nodeType,
          totalConsidered: nodes.length,
          deprecated,
          survived: decisions.filter((d) => d.survived).length,
        });
        totalDeprecated += deprecated.length;
      }

      return { perType, totalDeprecated, skipped: false };
    },
    // graph_mutation_count = total number of node-row UPDATE statements
    // committed (one per deprecated row). Same counting convention as
    // Confidence Agent's mode 1 wrapper.
    (result) => ({ graphMutationCount: result.totalDeprecated })
  );
}
