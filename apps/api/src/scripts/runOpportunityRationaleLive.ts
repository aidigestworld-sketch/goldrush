// Persistent runner for the Opportunity Rationale Agent.
// Same shape as runFounderFitLive.ts et al.
// Run: npx tsx -r dotenv/config src/scripts/runOpportunityRationaleLive.ts [opportunityId]
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runOpportunityRationaleAgent } from "../agents/live/opportunityRationaleAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const idArg = process.argv[2];
  const opportunity = idArg
    ? await prisma.opportunity.findUnique({ where: { id: idArg } })
    : await prisma.opportunity.findFirst({ orderBy: { createdAt: "desc" } });
  if (!opportunity) throw new Error(idArg ? `no opportunity ${idArg}` : "no opportunity exists");
  console.log(`Target opportunity: ${opportunity.id}`);

  // Model routing: reuse FounderFit's routing config as the default
  // for this agent — it's the closest existing agent by size of
  // output and reasoning shape. Add a dedicated OpportunityRationale
  // entry in model_routing_config later if the model needs tuning.
  const config =
    (await modelRoutingConfigRepository.latestForAgent("OpportunityRationale")) ??
    (await modelRoutingConfigRepository.latestForAgent("FounderFit"));
  if (!config) throw new Error("no model_routing_config found for OpportunityRationale or FounderFit");
  console.log(`Using model: ${config.nimModelId} (tier: ${config.tier}, version: ${config.version})`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  const result = await runOpportunityRationaleAgent(RUN_ID, opportunity.id, llm);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
