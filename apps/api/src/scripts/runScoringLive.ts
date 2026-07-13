// Persistent runner for Scoring Agent's live runs.
// Run: npx tsx -r dotenv/config src/scripts/runScoringLive.ts <candidateId>
import { runScoringAgent } from "../agents/live/scoringAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const candidateId = process.argv[2];
  if (!candidateId) throw new Error("usage: runScoringLive.ts <candidateId>");

  const run = await prisma.pipelineRun.findUnique({ where: { runId: RUN_ID } });
  if (!run) throw new Error(`pipeline_run ${RUN_ID} not found`);

  console.log(`Target candidate: ${candidateId}, vertical: ${run.vertical}`);
  const result = await runScoringAgent(RUN_ID, candidateId, run.vertical);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  const after = await prisma.opportunityCandidate.findUnique({ where: { id: candidateId } });
  console.log("\n=== CANDIDATE ROW AFTER ===");
  console.log(
    JSON.stringify(
      {
        id: after?.id,
        status: after?.status,
        opportunityQuality: after?.opportunityQuality,
        founderFitScore: after?.founderFitScore,
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
