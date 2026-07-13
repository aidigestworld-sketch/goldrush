// Persistent runner for Filtering Agent's live runs.
// Deterministic — no LLM call, just reads active market/audience/
// problem rows and deprecates those below the confidence threshold.
// Run: npx tsx -r dotenv/config src/scripts/runFilteringLive.ts [minConfidence]
import { runFilteringAgent, DEFAULT_MIN_CONFIDENCE } from "../agents/live/filteringAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const minConfidence = process.argv[2] ? Number(process.argv[2]) : DEFAULT_MIN_CONFIDENCE;
  console.log(`Filtering @ minConfidence=${minConfidence} (run=${RUN_ID})\n`);

  const result = await runFilteringAgent(RUN_ID, { minConfidence });
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
