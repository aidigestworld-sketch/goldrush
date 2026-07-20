// Real Composition Agent — Phase 5 live wrapper around the
// deterministic composition function in ../composition.ts.
//
// AI_AGENTS.md §8 / AGENT_EXECUTION_DAG.md stage 8. Deterministic (no
// LLM call): traverses the graph from a gate-clearing Hypothesis to
// resolve the 5 composition roles, calls composeCandidate() (pure
// function), and if all 5 roles resolve to an active row, INSERTs
// opportunity_candidate + 5 opportunity_candidate_composition rows.
//
// Writes ONLY: opportunity_candidate and opportunity_candidate_composition.
// Never touches scoring fields (opportunity_quality, venture_score,
// confidence_score, coverage, agreement, freshness, founder_fit_score)
// — those belong to Scoring / Confidence / Compression / FounderFit.
//
// Traversal chain from the hypothesis:
//   hypothesis
//     ├─ hypothesis_sources → problem (1 expected per hypothesis)
//     ├─ hypothesis_sources → existing_solution (N expected)
//     │      └─ monetizes_via → business_model
//     └─ (via problem)
//            ├─ experiences (reversed) → audience
//            └─ has_audience (reversed, via audience) → market
//
// Tie-break when a role has multiple active candidates:
//   1. highest node_source_refs count (evidence backing) desc
//   2. lowest id asc (deterministic tiebreak)
// This ordering is a spec-gap fix: §8 says "reachable via the
// hypothesis's edge chain" but doesn't specify tie-break when
// multiple reachable candidates exist. Committed here as
// "prefer the row with the most evidence backing, break ties by
// stable id."
//
// GATE: hypothesis.validation_score must be >= VALIDATION_GATE_THRESHOLD
// (0.5). Same constant used in confidenceAgent.ts. Not imported to
// avoid a cross-agent runtime dep — Composition is a Confidence
// downstream in the DAG, not the other way around, but keeping them
// decoupled at the module level.
import { composeCandidate, type CompositionInput } from "../composition";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";
import { tryResolveHypothesisIdForRun } from "../../orchestrator/idResolvers";

export const VALIDATION_GATE_THRESHOLD = 0.5;

export interface CompositionRunResult {
  candidateId: string | null;
  composition: { role: string; nodeId: string; nodeLabel: string | null }[] | null;
  missingOrInactiveRoles: string[];
  skipped: boolean;
  skipReason?: string;
}

// hypothesisId is `string | undefined` (not required). Two things this
// entry-point resolution buys us:
//   1. Stripe-originated runs never carry a pre-existing trackingKey —
//      resolution finds the run's hypothesis via pipelineRunId fallback.
//   2. If no hypothesis exists for the run (upstream Discovery / Expansion /
//      Hypothesis all legitimately skipped because Discovery wrote zero
//      markets, for instance), the agent SKIPS cleanly rather than
//      throwing — matches the tryResolveProblemIdForRun / tryResolveCandidateIdForRun
//      pattern used elsewhere in the DAG so the run's status doesn't
//      falsely flip to 'failed' on a legitimate partial-completion.
export async function runCompositionAgent(
  runId: string,
  hypothesisId: string | undefined
): Promise<CompositionRunResult> {
  const resolvedHypothesisId = await tryResolveHypothesisIdForRun(runId, hypothesisId);
  if (!resolvedHypothesisId) return skip("no active hypothesis for run — upstream Hypothesis step produced no row");
  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: resolvedHypothesisId } });
  if (!hypothesis || hypothesis.status !== "active") {
    return skip(`hypothesis ${resolvedHypothesisId} not found or not active`);
  }
  if (hypothesis.validationScore === null || hypothesis.validationScore < VALIDATION_GATE_THRESHOLD) {
    return skip(
      `hypothesis ${resolvedHypothesisId} has validation_score=${hypothesis.validationScore} — below gate ${VALIDATION_GATE_THRESHOLD} or not yet scored`
    );
  }

  // 1. Problem via hypothesis_sources (expected: exactly one per this
  // project's hypothesis-sources structure).
  const sources = await prisma.hypothesisSource.findMany({ where: { hypothesisId: resolvedHypothesisId } });
  if (sources.length === 0) {
    return skip("hypothesis has zero hypothesis_sources rows — no problem/existing_solution linkage");
  }
  const problemIds = [...new Set(sources.map((s) => s.problemId))];
  if (problemIds.length !== 1) {
    return skip(`hypothesis links to ${problemIds.length} distinct problems — spec expects exactly 1`);
  }
  const problem = await prisma.problem.findUnique({ where: { id: problemIds[0] } });
  if (!problem || problem.status !== "active") {
    return skip(`linked problem ${problemIds[0]} not found or not active`);
  }

  // 2. ExistingSolution + chained BusinessModel (existing_solution_id
  // is nullable on hypothesis_sources; skip nulls).
  const existingSolutionIds = sources.map((s) => s.existingSolutionId).filter((id): id is string => id !== null);
  if (existingSolutionIds.length === 0) {
    return skip("hypothesis has no linked existing_solutions — cannot resolve business_model");
  }
  const chosenExistingSolutionId = await pickBestNode("existing_solution", existingSolutionIds);
  if (!chosenExistingSolutionId) {
    return skip(`no active existing_solution among ${existingSolutionIds.length} candidates`);
  }
  const bmEdges = await prisma.edge.findMany({
    where: { edgeType: "monetizes_via", fromId: chosenExistingSolutionId, fromType: "existing_solution" },
  });
  if (bmEdges.length === 0) {
    return skip(`existing_solution ${chosenExistingSolutionId} has no monetizes_via edge to any business_model`);
  }
  const chosenBusinessModelId = await pickBestNode(
    "business_model",
    bmEdges.map((e) => e.toId)
  );
  if (!chosenBusinessModelId) return skip("no active business_model reachable via chosen existing_solution");
  const businessModel = await prisma.businessModel.findUnique({ where: { id: chosenBusinessModelId } });
  if (!businessModel) return skip(`business_model ${chosenBusinessModelId} vanished between edge and row lookup`);

  // 3. Audience via experiences edges → problem (reversed).
  const experiencesEdges = await prisma.edge.findMany({
    where: { edgeType: "experiences", toId: problem.id, toType: "problem" },
  });
  if (experiencesEdges.length === 0) {
    // Pre-2026-07-16, Expansion's live wrapper didn't write
    // experiences edges at all — this branch was the terminal state
    // for every run and every run silently resolved to
    // insufficient_evidence regardless of hypothesis strength (see
    // run d84f73a7). Now that expansionAgent.ts writes them
    // unconditionally (with a Cartesian fallback when the model
    // omits experiencing_audience_labels), the only way to land here
    // is a legitimate structural gap: the problem was created outside
    // of Expansion (e.g. a partial-completion run whose Expansion
    // step was retried and produced problems without re-linking to
    // the earlier audiences, or a manual DB fixup). Keep the skip
    // — but the message is now diagnostic ("real gap, investigate")
    // rather than "known missing implementation."
    return skip(
      `problem ${problem.id} has no experiences edges from any audience — Expansion should have written them; investigate whether this problem was created outside the normal Expansion write path`
    );
  }
  const chosenAudienceId = await pickBestNode(
    "audience",
    experiencesEdges.map((e) => e.fromId)
  );
  if (!chosenAudienceId) return skip("no active audience reachable via experiences edges");
  const audience = await prisma.audience.findUnique({ where: { id: chosenAudienceId } });
  if (!audience) return skip(`audience ${chosenAudienceId} vanished between edge and row lookup`);

  // 4. Market via has_audience → audience (reversed).
  const marketEdges = await prisma.edge.findMany({
    where: { edgeType: "has_audience", toId: audience.id, toType: "audience" },
  });
  if (marketEdges.length === 0) return skip(`audience ${audience.id} has no incoming has_audience edge from any market`);
  const chosenMarketId = await pickBestNode(
    "market",
    marketEdges.map((e) => e.fromId)
  );
  if (!chosenMarketId) return skip("no active market reachable via has_audience edges");
  const market = await prisma.market.findUnique({ where: { id: chosenMarketId } });
  if (!market) return skip(`market ${chosenMarketId} vanished between edge and row lookup`);

  // 5. Deterministic compose via the pure function — this is the
  // §8-invariant check ("all five roles resolve to an active row")
  // living in shared code, not duplicated here.
  const compositionInput: CompositionInput = {
    market: { id: market.id, status: market.status },
    audience: { id: audience.id, status: audience.status },
    problem: { id: problem.id, status: problem.status },
    hypothesis: { id: hypothesis.id, status: hypothesis.status },
    businessModel: { id: businessModel.id, status: businessModel.status },
  };
  const composeResult = composeCandidate(compositionInput);
  if (!composeResult.success) {
    return skip(`composeCandidate rejected: missing/inactive roles: ${composeResult.missingOrInactiveRoles.join(", ")}`);
  }

  return agentExecutionLogService.run(
    { runId, agentName: "Composition", candidateId: null, modelUsed: null },
    async () => {
      const created = await prisma.opportunityCandidate.create({
        data: { runId, status: "candidate" },
      });
      await prisma.opportunityCandidateComposition.createMany({
        data: composeResult.composition!.map((c) => ({
          candidateId: created.id,
          nodeId: c.nodeId,
          nodeType: nodeTypeForRole(c.role),
          role: c.role,
        })),
      });

      const labeled = [
        { role: "market", nodeId: market.id, nodeLabel: market.label },
        { role: "audience", nodeId: audience.id, nodeLabel: audience.label },
        { role: "problem", nodeId: problem.id, nodeLabel: problem.label },
        { role: "hypothesis", nodeId: hypothesis.id, nodeLabel: hypothesis.label },
        { role: "business_model", nodeId: businessModel.id, nodeLabel: businessModel.label },
      ];
      return {
        candidateId: created.id,
        composition: labeled,
        missingOrInactiveRoles: [],
        skipped: false,
      };
    },
    // graph_mutation_count: 1 candidate row insert + 5 composition rows = 6.
    (result) => ({ graphMutationCount: result.skipped ? 0 : 6 })
  );
}

function nodeTypeForRole(role: string): string {
  return role;
}

async function pickBestNode(nodeType: string, candidateIds: string[]): Promise<string | null> {
  if (candidateIds.length === 0) return null;
  const active = await filterActiveByType(nodeType, candidateIds);
  if (active.length === 0) return null;
  const refs = await prisma.nodeSourceRef.groupBy({
    by: ["nodeId"],
    where: { nodeType, nodeId: { in: active } },
    _count: { evidenceId: true },
  });
  const refCountById = new Map(refs.map((r) => [r.nodeId, r._count.evidenceId]));
  active.sort((a, b) => {
    const diff = (refCountById.get(b) ?? 0) - (refCountById.get(a) ?? 0);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  return active[0];
}

async function filterActiveByType(nodeType: string, ids: string[]): Promise<string[]> {
  const activeIds: string[] = [];
  if (nodeType === "market") {
    const rows = await prisma.market.findMany({ where: { id: { in: ids }, status: "active" }, select: { id: true } });
    activeIds.push(...rows.map((r) => r.id));
  } else if (nodeType === "audience") {
    const rows = await prisma.audience.findMany({ where: { id: { in: ids }, status: "active" }, select: { id: true } });
    activeIds.push(...rows.map((r) => r.id));
  } else if (nodeType === "problem") {
    const rows = await prisma.problem.findMany({ where: { id: { in: ids }, status: "active" }, select: { id: true } });
    activeIds.push(...rows.map((r) => r.id));
  } else if (nodeType === "existing_solution") {
    const rows = await prisma.existingSolution.findMany({
      where: { id: { in: ids }, status: "active" },
      select: { id: true },
    });
    activeIds.push(...rows.map((r) => r.id));
  } else if (nodeType === "business_model") {
    const rows = await prisma.businessModel.findMany({
      where: { id: { in: ids }, status: "active" },
      select: { id: true },
    });
    activeIds.push(...rows.map((r) => r.id));
  }
  return activeIds;
}

function skip(reason: string): CompositionRunResult {
  return { candidateId: null, composition: null, missingOrInactiveRoles: [], skipped: true, skipReason: reason };
}
