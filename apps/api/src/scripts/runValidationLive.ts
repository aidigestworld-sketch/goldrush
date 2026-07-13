// Permanent, reusable runner for Validation Agent's live runs.
// Run: npx tsx -r dotenv/config src/scripts/runValidationLive.ts [hypothesisId]
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runValidationAgent } from "../agents/live/validationAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const hypothesisIdArg = process.argv[2];
  const hypothesis = hypothesisIdArg
    ? await prisma.hypothesis.findUnique({ where: { id: hypothesisIdArg } })
    : await prisma.hypothesis.findFirst({ where: { status: "active" }, orderBy: { createdAt: "desc" } });

  if (!hypothesis) {
    throw new Error(
      hypothesisIdArg ? `no hypothesis found with id ${hypothesisIdArg}` : "no active hypothesis found at all"
    );
  }
  console.log(`Target hypothesis: ${hypothesis.id} — "${hypothesis.statement}"`);

  const config = await modelRoutingConfigRepository.latestForAgent("Validation");
  if (!config) throw new Error("no model_routing_config found for Validation");
  console.log(`Using model: ${config.nimModelId} (tier: ${config.tier}, version: ${config.version})`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  const result = await runValidationAgent(RUN_ID, hypothesis.id, llm);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
