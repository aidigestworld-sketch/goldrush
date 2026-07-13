// Persistent runner for Compression Agent's live runs.
// Compression is RUN-SCOPED, not candidate-scoped — it compares all
// candidates in a pipeline_run and picks one winner via the pure
// function's tie-break sequence, then executes the promotion
// transaction (DATABASE_SCHEMA.md §8).
//
// Accepts either a runId (primary) or a candidateId (resolved to
// its runId for convenience — matches how a Phase 6 Orchestrator
// will eventually fire the join step off any branch completion).
//
// Run: npx tsx -r dotenv/config src/scripts/runCompressionLive.ts [runId | candidateId]
import { runCompressionAgent } from "../agents/live/compressionAgent";
import { prisma } from "../db/client";

const DEFAULT_RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const arg = process.argv[2];
  let runId = DEFAULT_RUN_ID;
  if (arg) {
    // Distinguish runId (exists as pipeline_run.run_id) from
    // candidateId (exists as opportunity_candidate.id).
    const asRun = await prisma.pipelineRun.findUnique({ where: { runId: arg } });
    if (asRun) {
      runId = arg;
    } else {
      const asCand = await prisma.opportunityCandidate.findUnique({ where: { id: arg } });
      if (!asCand) throw new Error(`argument ${arg} is neither a run_id nor a candidate id`);
      runId = asCand.runId;
      console.log(`(argument ${arg} interpreted as candidateId → runId=${runId})`);
    }
  }

  console.log(`Compression target run: ${runId}\n`);
  const result = await runCompressionAgent(runId);
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n=== RUN STATE AFTER ===");
  const run = await prisma.pipelineRun.findUnique({ where: { runId } });
  console.log(
    JSON.stringify(
      {
        runId: run?.runId,
        currentStage: run?.currentStage,
        status: run?.status,
        completedAt: run?.completedAt,
      },
      null,
      2
    )
  );

  if (result.createdOpportunityId) {
    const opp = await prisma.opportunity.findUnique({ where: { id: result.createdOpportunityId } });
    console.log("\n=== CREATED opportunity ROW ===");
    console.log(JSON.stringify(opp, null, 2));

    const promotesEdge = await prisma.edge.findFirst({
      where: { edgeType: "promotes", toId: result.createdOpportunityId },
    });
    console.log("\n=== promotes EDGE ===");
    console.log(JSON.stringify(promotesEdge, null, 2));
  }

  const candidatesAfter = await prisma.opportunityCandidate.findMany({
    where: { runId },
    select: {
      id: true,
      status: true,
      deprecationReason: true,
      opportunityQuality: true,
      confidenceScore: true,
      founderFitScore: true,
    },
    orderBy: { createdAt: "asc" },
  });
  console.log("\n=== CANDIDATES AFTER ===");
  for (const c of candidatesAfter) {
    console.log(JSON.stringify(c, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
