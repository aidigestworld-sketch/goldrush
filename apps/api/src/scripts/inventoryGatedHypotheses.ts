// Inventory: which active hypotheses have cleared Confidence Mode 1 gate
// (validation_score >= VALIDATION_GATE_THRESHOLD, status='active'), and
// which of those do NOT yet have a composed opportunity_candidate?
// Read-only. No writes, no LLM calls.
// Run: npx tsx -r dotenv/config src/scripts/inventoryGatedHypotheses.ts
import { prisma } from "../db/client";
import { VALIDATION_GATE_THRESHOLD } from "../agents/live/confidenceAgent";

async function main() {
  const gated = await prisma.hypothesis.findMany({
    where: {
      status: "active",
      validationScore: { gte: VALIDATION_GATE_THRESHOLD },
    },
    orderBy: { validationScore: "desc" },
  });

  const compositionRows = await prisma.opportunityCandidateComposition.findMany({
    where: { nodeType: "hypothesis", nodeId: { in: gated.map((h) => h.id) } },
  });
  const alreadyComposedHypothesisIds = new Set(compositionRows.map((r) => r.nodeId));

  const withoutCandidate = gated.filter((h) => !alreadyComposedHypothesisIds.has(h.id));
  const withCandidate = gated.filter((h) => alreadyComposedHypothesisIds.has(h.id));

  console.log(`Gate threshold: ${VALIDATION_GATE_THRESHOLD}`);
  console.log(`Gated hypotheses (active, validation_score >= ${VALIDATION_GATE_THRESHOLD}): ${gated.length}`);
  console.log(`  already have opportunity_candidate: ${withCandidate.length}`);
  console.log(`  do NOT yet have opportunity_candidate: ${withoutCandidate.length}`);

  console.log("\n=== WITHOUT CANDIDATE (ready for Composition) ===");
  for (const h of withoutCandidate) {
    console.log(
      JSON.stringify(
        {
          hypothesis_id: h.id,
          validation_score: h.validationScore,
          statement: h.statement,
        },
        null,
        2
      )
    );
  }

  console.log("\n=== ALREADY COMPOSED (opportunity_candidate exists) ===");
  for (const h of withCandidate) {
    console.log(
      JSON.stringify(
        {
          hypothesis_id: h.id,
          validation_score: h.validationScore,
          statement: h.statement,
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
