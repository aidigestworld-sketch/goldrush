// Persistent runner for Confidence Mode 2 Agent's live runs.
// Deterministic — no LLM call, just loads graph state and writes
// the 5 owned columns on opportunity_candidate.
// Run: npx tsx -r dotenv/config src/scripts/runConfidenceMode2Live.ts <candidateId>
import { runConfidenceMode2Agent } from "../agents/live/confidenceMode2Agent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const candidateId = process.argv[2];
  if (!candidateId) throw new Error("usage: runConfidenceMode2Live.ts <candidateId>");

  console.log(`Target candidate: ${candidateId}\n`);
  const result = await runConfidenceMode2Agent(RUN_ID, candidateId);
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  const after = await prisma.opportunityCandidate.findUnique({ where: { id: candidateId } });
  console.log("\n=== CANDIDATE ROW AFTER (persisted state) ===");
  console.log(
    JSON.stringify(
      {
        id: after?.id,
        status: after?.status,
        opportunityQuality: after?.opportunityQuality,
        founderFitScore: after?.founderFitScore,
        // Round 2 columns:
        confidenceCoverageGate: after?.confidenceCoverageGate,
        incompleteComposition: after?.incompleteComposition,
        confidenceAgreement: after?.confidenceAgreement,
        confidenceFreshness: after?.confidenceFreshness,
        confidenceScore: after?.confidenceScore,
        // Legacy columns (should still be NULL — Mode 2 doesn't touch them):
        legacyCoverage: after?.coverage,
        legacyAgreement: after?.agreement,
        legacyFreshness: after?.freshness,
      },
      null,
      2
    )
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
