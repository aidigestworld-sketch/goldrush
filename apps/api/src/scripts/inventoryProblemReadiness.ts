// Per-Problem readiness snapshot: which problems can (a) yield a
// Hypothesis (have addressed_by → ExistingSolution → monetizes_via
// → BusinessModel), (b) reach an Audience via experiences, (c) reach
// a Market via has_audience — i.e. which problems Composition could
// resolve once a gated hypothesis is generated.
// Read-only.
// Run: npx tsx -r dotenv/config src/scripts/inventoryProblemReadiness.ts
import { prisma } from "../db/client";

async function main() {
  const problems = await prisma.problem.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Active problems: ${problems.length}`);

  for (const p of problems) {
    const addressedBy = await prisma.edge.findMany({
      where: { edgeType: "addressed_by", fromId: p.id, fromType: "problem" },
    });
    const existingSolutions = await prisma.existingSolution.findMany({
      where: { id: { in: addressedBy.map((e) => e.toId) }, status: "active" },
    });
    const bmEdges = await prisma.edge.findMany({
      where: {
        edgeType: "monetizes_via",
        fromId: { in: existingSolutions.map((s) => s.id) },
        fromType: "existing_solution",
      },
    });
    const businessModels = await prisma.businessModel.findMany({
      where: { id: { in: bmEdges.map((e) => e.toId) }, status: "active" },
    });
    const experiencesEdges = await prisma.edge.findMany({
      where: { edgeType: "experiences", toId: p.id, toType: "problem" },
    });
    const audiences = await prisma.audience.findMany({
      where: { id: { in: experiencesEdges.map((e) => e.fromId) }, status: "active" },
    });
    const marketEdges = await prisma.edge.findMany({
      where: {
        edgeType: "has_audience",
        toId: { in: audiences.map((a) => a.id) },
        toType: "audience",
      },
    });
    const markets = await prisma.market.findMany({
      where: { id: { in: marketEdges.map((e) => e.fromId) }, status: "active" },
    });
    const hypothesisSources = await prisma.hypothesisSource.findMany({
      where: { problemId: p.id },
    });
    const hypothesisIds = [...new Set(hypothesisSources.map((s) => s.hypothesisId))];
    const hypotheses = await prisma.hypothesis.findMany({
      where: { id: { in: hypothesisIds } },
      select: { id: true, statement: true, status: true, validationScore: true },
    });
    const evidenceRefs = await prisma.nodeSourceRef.count({
      where: { nodeId: p.id, nodeType: "problem" },
    });

    const readyForComposition =
      existingSolutions.length > 0 &&
      businessModels.length > 0 &&
      audiences.length > 0 &&
      markets.length > 0;

    console.log(
      "\n" +
        JSON.stringify(
          {
            problem_id: p.id,
            label: p.label,
            evidence_refs_backing_problem: evidenceRefs,
            active_existing_solutions: existingSolutions.length,
            active_business_models_reachable: businessModels.length,
            active_audiences_reachable: audiences.length,
            active_markets_reachable: markets.length,
            existing_hypotheses: hypotheses.length,
            hypothesis_summary: hypotheses.map((h) => ({
              id: h.id,
              status: h.status,
              validationScore: h.validationScore,
              snippet: h.statement.substring(0, 90),
            })),
            ready_for_hypothesis_agent: existingSolutions.length > 0,
            ready_for_composition_chain: readyForComposition,
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
