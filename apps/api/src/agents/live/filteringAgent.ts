// Real Filtering Agent — DAG stage 3. AI_AGENTS.md §3. Deterministic
// (no LLM call) — the whole computation lives in ../filtering.ts's
// pure function; this wrapper only does the graph read, applies the
// pure decision function, and commits the deprecations.
//
// SCOPE: filters MARKET and PROBLEM only. Deliberately excludes
// AUDIENCE, updated 2026-07-16 after run 58895448 investigation.
//
// Original scope was {market, audience, problem} — the three node
// types created by stages 1–2 (Discovery + Expansion). The rationale
// was DAG-position: those are what Filtering can see at stage 3.
// That reason is accidental. The real reason to include a node type
// in Filtering is SEMANTIC: it must carry a meaningful confidence
// signal that Filtering can act on.
//
//   * Market — Discovery emits `confidence` per market grounded in
//     demand/industry-report signal strength. Real signal → filter it.
//   * Problem — `problemRepository.create` derives `confidence`
//     deterministically from severity_signal and frequency_signal
//     (see problem.repository.ts:19-24), both of which the
//     expansionSandbox requires to be grounded in verbatim source-
//     text quotes (severity_evidence_quote / frequency_evidence_quote).
//     Real signal, evidence-grounded → filter it.
//   * Audience — the expansionSandbox's AudienceCandidateSchema is
//     {label, description, evidence_refs} only. No confidence field,
//     because there's no observable proxy for "how confident are we
//     that this demographic segment exists" — audience is a
//     categorical identifier, not a scored assertion. Audiences are
//     written to the DB with confidence=NULL by construction.
//
// Including audience in Filtering meant Filtering deprecated every
// audience Expansion produced (confidence=NULL triggers the
// "missing_confidence" branch in filtering.ts). That silently killed
// Composition's audience-lookup — no active audience → no candidate →
// insufficient_evidence, regardless of hypothesis strength. Root
// cause of run 58895448's zero-candidate result. The correct fix is
// to remove audience from Filtering's scope, not to force a
// confidence value onto audiences that no observable proxy grounds.
//
// If audience quality-scoring ever becomes a real requirement (e.g.
// multiple audiences per market with varying evidence support), the
// right move is a new pure function with its own signal (e.g.
// distinct-source-count per audience), NOT bolting a made-up
// confidence number onto the audience schema. See the observable-
// proxy invariant expansionSandbox.ts:5-8 for why.
//
// Writes ONLY: UPDATE {market,problem} SET status='deprecated',
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
    nodeType: "market" | "problem";
    totalConsidered: number;
    deprecated: { id: string; deprecationReason: string }[];
    survived: number;
  }[];
  totalDeprecated: number;
  skipped: boolean;
  skipReason?: string;
}

// Table-driven so each node type's read+write pair is one place.
// Scoped to types that carry a meaningful confidence signal —
// see the semantic-scope discussion in the file header for why
// audience is deliberately excluded.
type ScopedNodeType = "market" | "problem";

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
  const rows = await prisma.problem.findMany({
    where: { status: "active", pipelineRunId },
    select: { id: true, confidence: true },
  });
  return rows.map((r) => ({ id: r.id, confidence: r.confidence }));
}

async function deprecate(nodeType: ScopedNodeType, id: string, reason: string) {
  const data = { status: "deprecated" as const, deprecationReason: reason };
  if (nodeType === "market") return prisma.market.update({ where: { id }, data });
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

      for (const nodeType of ["market", "problem"] as ScopedNodeType[]) {
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
