// Wider inventory: counts across the whole pipeline for shopify_subscriptions,
// so we can estimate what it costs to grow the gated-hypothesis pool.
// Read-only.
// Run: npx tsx -r dotenv/config src/scripts/inventoryPipelineState.ts
import { prisma } from "../db/client";

async function main() {
  const [
    hyp,
    hypActive,
    hypActiveScored,
    hypActiveUnscored,
    hypDeprecated,
    hypActiveGatePassed,
    hypActiveGateFailed,
    problems,
    problemsActive,
    existingSolutions,
    existingSolutionsActive,
    markets,
    audiences,
    businessModels,
    candidates,
    compositions,
    evidence,
    nodeRefs,
    searchLogs,
    runs,
  ] = await Promise.all([
    prisma.hypothesis.count(),
    prisma.hypothesis.count({ where: { status: "active" } }),
    prisma.hypothesis.count({ where: { status: "active", validationScore: { not: null } } }),
    prisma.hypothesis.count({ where: { status: "active", validationScore: null } }),
    prisma.hypothesis.count({ where: { status: "deprecated" } }),
    prisma.hypothesis.count({ where: { status: "active", validationScore: { gte: 0.5 } } }),
    prisma.hypothesis.count({
      where: { status: "active", validationScore: { lt: 0.5, not: null } },
    }),
    prisma.problem.count(),
    prisma.problem.count({ where: { status: "active" } }),
    prisma.existingSolution.count(),
    prisma.existingSolution.count({ where: { status: "active" } }),
    prisma.market.count(),
    prisma.audience.count(),
    prisma.businessModel.count(),
    prisma.opportunityCandidate.count(),
    prisma.opportunityCandidateComposition.count(),
    prisma.evidence.count(),
    prisma.nodeSourceRef.count(),
    prisma.pipelineSearchLog.count(),
    prisma.pipelineRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 5,
      select: { runId: true, vertical: true, currentStage: true, status: true, startedAt: true },
    }),
  ]);

  console.log("=== PIPELINE-WIDE COUNTS ===");
  console.log(
    JSON.stringify(
      {
        hypothesis: {
          total: hyp,
          active: hypActive,
          active_scored: hypActiveScored,
          active_unscored: hypActiveUnscored,
          deprecated: hypDeprecated,
          active_gate_passed_gte_0_5: hypActiveGatePassed,
          active_gate_failed_lt_0_5: hypActiveGateFailed,
        },
        problem: { total: problems, active: problemsActive },
        existing_solution: { total: existingSolutions, active: existingSolutionsActive },
        market: markets,
        audience: audiences,
        business_model: businessModels,
        opportunity_candidate: candidates,
        opportunity_candidate_composition_rows: compositions,
        evidence: evidence,
        node_source_refs: nodeRefs,
        pipeline_search_log: searchLogs,
      },
      null,
      2
    )
  );

  console.log("\n=== RECENT PIPELINE RUNS ===");
  console.log(JSON.stringify(runs, null, 2));

  console.log("\n=== ACTIVE HYPOTHESES (all, incl. unscored) ===");
  const activeHyp = await prisma.hypothesis.findMany({
    where: { status: "active" },
    orderBy: [{ validationScore: "desc" }, { createdAt: "desc" }],
  });
  for (const h of activeHyp) {
    console.log(
      JSON.stringify(
        {
          id: h.id,
          validation_score: h.validationScore,
          created_at: h.createdAt.toISOString(),
          statement: h.statement.substring(0, 140),
        },
        null,
        2
      )
    );
  }

  console.log("\n=== DEPRECATED HYPOTHESES (with reason) ===");
  const deprecatedHyp = await prisma.hypothesis.findMany({
    where: { status: "deprecated" },
    orderBy: { createdAt: "desc" },
  });
  for (const h of deprecatedHyp) {
    console.log(
      JSON.stringify(
        {
          id: h.id,
          validation_score: h.validationScore,
          deprecation_reason: h.deprecationReason,
          statement: h.statement.substring(0, 140),
        },
        null,
        2
      )
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
