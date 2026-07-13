// Permanent, reusable runner for Hypothesis Agent's live runs against
// real NIM + real Postgres. Same reasoning as
// runCompetitiveAnalysisLive.ts: persisted, not throwaway, so a fresh
// Claude Code session can always re-invoke it.
//
// Run: npx tsx -r dotenv/config src/scripts/runHypothesisLive.ts [problemId]
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runHypothesisAgent } from "../agents/live/hypothesisAgent";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166"; // same pipeline_run used throughout this project's Phase 4/5 work

async function main() {
  const problemIdArg = process.argv[2];
  const problem = problemIdArg
    ? await prisma.problem.findUnique({ where: { id: problemIdArg } })
    : await prisma.problem.findFirst({ where: { label: { contains: "distinguish" } } });

  if (!problem) {
    throw new Error(
      problemIdArg
        ? `no problem found with id ${problemIdArg}`
        : `no problem found with label containing "distinguish" — pass a problem id explicitly as an argument`
    );
  }
  console.log(`Target problem: ${problem.id} — "${problem.label}"`);

  const config = await modelRoutingConfigRepository.latestForAgent("Hypothesis");
  if (!config) throw new Error("no model_routing_config found for Hypothesis");
  console.log(`Using model: ${config.nimModelId} (tier: ${config.tier}, version: ${config.version})`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  const result = await runHypothesisAgent(RUN_ID, problem.id, llm);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
