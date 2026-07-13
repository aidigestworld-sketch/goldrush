// Commit-mode counterpart to runValidationSearchDryRun.ts. Symmetric
// script, symmetric wiring, one flag flipped: dryRun: false.
//
// What this does:
//   1. Runs the Data Pipeline active-search capability against the
//      target hypothesis — issues TWO Tavily calls (raw
//      hypothesis.statement + LLM-reformulated mechanism-specific
//      yes/no question), INSERTs both pipeline_search_log rows, and
//      persists retrieved evidence rows (deduped by URL across the
//      two result sets).
//   2. Feeds the combined pool (existing corpus not-yet-cited +
//      new Tavily-retrieved) into Validation Sandbox's classifier.
//   3. Persists supporting/contradicting classifications as
//      node_source_refs with correct evidence_polarity.
//   4. Appends any unresolved_questions to hypothesis.missing_data.
//
// Deliberately does NOT run Confidence Agent afterwards — that's a
// separate step per §7 and the current task explicitly stops at
// Validation to let the evidence layer be reviewed before scoring.
//
// Run: npx tsx -r dotenv/config src/scripts/runValidationSearchLive.ts <hypothesisId>
import { runValidationAgent, type ValidationSearchProvider } from "../agents/live/validationAgent";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { searchForHypothesisEvidence } from "../pipeline/searchForHypothesisEvidence";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const hypothesisId = process.argv[2];
  if (!hypothesisId) throw new Error("usage: runValidationSearchLive.ts <hypothesisId>");

  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: hypothesisId } });
  if (!hypothesis) throw new Error(`no hypothesis ${hypothesisId}`);
  console.log(`Target hypothesis: ${hypothesis.id}`);
  console.log(`Statement: ${hypothesis.statement}\n`);

  const config = await modelRoutingConfigRepository.latestForAgent("Validation");
  if (!config) throw new Error("no model_routing_config found for Validation");
  console.log(`Using model: ${config.nimModelId} (tier=${config.tier}, version=${config.version})`);
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (!nvidiaKey) throw new Error("NVIDIA_API_KEY not set");
  const llm = new NimLLMClient(nvidiaKey, config.nimModelId);

  const searchProvider: ValidationSearchProvider = async (ctx) => {
    // Same NIM client the classifier uses is reused for reformulation
    // — one API relationship, one model, no extra config surface.
    const r = await searchForHypothesisEvidence(ctx, { reformulationLlm: llm });
    return { normalized: r.normalized, searchLogPayloads: r.searchLogPayloads };
  };

  const missingDataBefore = hypothesis.missingData.length;

  const result = await runValidationAgent(RUN_ID, hypothesis.id, llm, {
    searchProvider,
    dryRun: false,
  });

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
        missingDataBefore,
        missingDataAfter: after?.missingData.length,
        missingDataDelta: (after?.missingData.length ?? 0) - missingDataBefore,
        missingData: after?.missingData,
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
