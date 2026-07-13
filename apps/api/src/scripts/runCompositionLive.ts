// Persistent runner for Composition Agent's live runs.
// Run: npx tsx -r dotenv/config src/scripts/runCompositionLive.ts [hypothesisId]
import { runCompositionAgent } from "../agents/live/compositionAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const hypothesisIdArg = process.argv[2];
  const hypothesis = hypothesisIdArg
    ? await prisma.hypothesis.findUnique({ where: { id: hypothesisIdArg } })
    : await prisma.hypothesis.findFirst({
        where: { status: "active", validationScore: { gte: 0.5 } },
        orderBy: { validationScore: "desc" },
      });
  if (!hypothesis) {
    throw new Error(
      hypothesisIdArg
        ? `no hypothesis ${hypothesisIdArg}`
        : "no gate-clearing active hypothesis found"
    );
  }
  console.log(`Target hypothesis: ${hypothesis.id} — validation_score=${hypothesis.validationScore}`);
  console.log(`Statement: ${hypothesis.statement}\n`);

  const result = await runCompositionAgent(RUN_ID, hypothesis.id);
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
