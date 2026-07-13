// Dry-run: exercise Validation Collector's new active-search path
// against a real hypothesis, without any DB writes.
//
// Run: npx tsx -r dotenv/config src/scripts/runValidationSearchDryRun.ts <hypothesisId>
//
// Prints:
//   * the query text that was sent to Tavily (currently: the raw
//     hypothesis statement — see searchForHypothesisEvidence.ts for
//     why query-builder-cleverness is deferred),
//   * Tavily's raw results (title, url, score, published_date, content),
//   * how each result was normalized into a NormalizedEvidence row,
//   * the search-log payload that a real (non-dry) run would persist
//     to pipeline_search_log (schema proposal documented in
//     searchForHypothesisEvidence.ts's header),
//   * the combined candidate-pool size the classifier WOULD see if
//     this weren't a dry-run.
//
// The Validation Agent's classifier is deliberately not invoked here —
// dry-run mode short-circuits before the LLM call so we can inspect
// the Data Pipeline output on its own, in isolation from any grading.
// Search-and-grading stay separate steps, per §20.2.
import { runValidationAgent, type ValidationSearchProvider } from "../agents/live/validationAgent";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { searchForHypothesisEvidence } from "../pipeline/searchForHypothesisEvidence";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const hypothesisId = process.argv[2];
  if (!hypothesisId) throw new Error("usage: runValidationSearchDryRun.ts <hypothesisId>");

  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: hypothesisId } });
  if (!hypothesis) throw new Error(`no hypothesis ${hypothesisId}`);
  console.log(`Target hypothesis: ${hypothesis.id}`);
  console.log(`Statement: ${hypothesis.statement}\n`);

  // The LLM is required by the Validation Agent's signature but will
  // NEVER be called in dry-run mode. Construct it anyway so a live
  // flip to dryRun=false Just Works without changing this script.
  const config = await modelRoutingConfigRepository.latestForAgent("Validation");
  if (!config) throw new Error("no model_routing_config found for Validation");
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  if (!nvidiaKey) throw new Error("NVIDIA_API_KEY not set");
  const llm = new NimLLMClient(nvidiaKey, config.nimModelId);

  const searchProvider: ValidationSearchProvider = async (ctx) => {
    // Same reformulation-enabled path the live commit uses — dry-run
    // exercises the exact production shape so the preview reflects
    // what a committed run would actually classify.
    const r = await searchForHypothesisEvidence(ctx, { reformulationLlm: llm });
    return { normalized: r.normalized, searchLogPayloads: r.searchLogPayloads };
  };

  const result = await runValidationAgent(RUN_ID, hypothesis.id, llm, {
    searchProvider,
    dryRun: true,
  });

  console.log(
    `=== SEARCH LOG PAYLOADS (${(result.searchLogPayloads ?? []).length} rows — one per Tavily call, all persisted to pipeline_search_log even in dry-run) ===`
  );
  console.log(JSON.stringify(result.searchLogPayloads, null, 2));
  console.log("");

  console.log(`=== NORMALIZED EVIDENCE (${result.searchRetrievedCount} results) ===`);
  const normalized = result.dryRunPreview?.retrievedNormalizedEvidence ?? [];
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    console.log(`\n--- Result ${i + 1} ---`);
    console.log(`  source_url_or_identifier: ${e.sourceUrlOrIdentifier}`);
    console.log(`  source_type:              ${e.sourceType}`);
    console.log(`  source_authority_tier:    ${e.sourceAuthorityTier}`);
    console.log(`  extraction_method:        ${e.extractionMethod}`);
    console.log(`  extraction_confidence:    ${e.extractionConfidence}`);
    console.log(`  freshness:                ${e.freshness}`);
    console.log(`  extracted_fact:`);
    console.log(`    ${e.extractedFact.replace(/\n/g, " ").substring(0, 400)}${e.extractedFact.length > 400 ? "…" : ""}`);
  }

  console.log("\n=== CANDIDATE POOL PREVIEW ===");
  console.log(`  corpus (already-ingested Evidence not yet cited): ${result.dryRunPreview?.corpusCandidatePoolSize}`);
  console.log(`  retrieved (new Tavily results, would-be-inserted): ${result.searchRetrievedCount}`);
  console.log(`  combined (what classifier would see in a real run): ${result.dryRunPreview?.combinedCandidatePoolSize}`);

  console.log("\n=== DRY-RUN CONFIRMATION ===");
  console.log(`  writes to evidence table:        NONE`);
  console.log(`  writes to node_source_refs:      NONE`);
  console.log(`  classifier LLM call:             NOT INVOKED`);
  console.log(`  hypothesis.missing_data append:  NONE`);
  console.log(`  hypothesis row status:           UNCHANGED (${hypothesis.status})`);
  if (result.skipped) console.log(`  agent skip reason:               ${result.skipReason}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
