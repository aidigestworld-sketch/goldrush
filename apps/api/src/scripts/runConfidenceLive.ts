// Permanent, reusable runner for Confidence Agent's live runs (Mode 1).
// Run: npx tsx -r dotenv/config src/scripts/runConfidenceLive.ts [hypothesisId]
//
// If no hypothesisId is passed, picks the most recently-created active
// hypothesis that still has validation_score = NULL — mirroring
// runValidationLive.ts's default target-selection but adding the
// "not yet scored" filter so re-invocations don't hit the same row
// twice by accident.
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runConfidenceAgent } from "../agents/live/confidenceAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const hypothesisIdArg = process.argv[2];
  const hypothesis = hypothesisIdArg
    ? await prisma.hypothesis.findUnique({ where: { id: hypothesisIdArg } })
    : await prisma.hypothesis.findFirst({
        where: { status: "active", validationScore: null },
        orderBy: { createdAt: "desc" },
      });

  if (!hypothesis) {
    throw new Error(
      hypothesisIdArg
        ? `no hypothesis found with id ${hypothesisIdArg}`
        : "no active hypothesis with validation_score=NULL found — either none exist yet, or Confidence has already scored them all"
    );
  }
  console.log(`Target hypothesis: ${hypothesis.id} — "${hypothesis.statement}"`);

  const config = await modelRoutingConfigRepository.latestForAgent("Confidence");
  if (!config) throw new Error("no model_routing_config found for Confidence");
  console.log(`Using model: ${config.nimModelId} (tier: ${config.tier}, version: ${config.version})`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  const result = await runConfidenceAgent(RUN_ID, hypothesis.id, llm);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  const after = await prisma.hypothesis.findUnique({ where: { id: hypothesis.id } });
  console.log("\n=== HYPOTHESIS ROW AFTER ===");
  console.log(
    JSON.stringify(
      {
        id: after?.id,
        status: after?.status,
        validationScore: after?.validationScore,
        validationComputedAtClusterVersion: after?.validationComputedAtClusterVersion,
        deprecationReason: after?.deprecationReason,
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
