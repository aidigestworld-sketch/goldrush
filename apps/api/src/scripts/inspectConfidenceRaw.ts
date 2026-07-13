// Diagnostic: run Confidence's sandbox against the real hypothesis's
// cited evidence WITHOUT committing anything, and dump the raw LLM
// response and parsed structure. Used to investigate bounded-rule
// violations that the wrapped agent skips over silently.
// Run: npx tsx -r dotenv/config src/scripts/inspectConfidenceRaw.ts <hypothesisId>
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import {
  runConfidenceSandbox,
  highestAuthorityTier,
  type ConfidenceEvidenceItem,
  type ConfidenceBackendFacts,
} from "../sandbox/confidenceSandbox";
import { prisma } from "../db/client";

async function main() {
  const hypothesisId = process.argv[2];
  if (!hypothesisId) throw new Error("usage: inspectConfidenceRaw.ts <hypothesisId>");

  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: hypothesisId } });
  if (!hypothesis) throw new Error(`no hypothesis ${hypothesisId}`);

  const refs = await prisma.nodeSourceRef.findMany({
    where: { nodeId: hypothesisId, nodeType: "hypothesis" },
  });
  const evidenceRows = await prisma.evidence.findMany({
    where: { id: { in: refs.map((r) => r.evidenceId) }, status: "active" },
  });

  const evidenceFor: ConfidenceEvidenceItem[] = evidenceRows.map((e) => ({
    id: e.id,
    sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
    sourceAuthorityTier: e.sourceAuthorityTier,
    text: e.extractedFact,
  }));

  console.log(`Evidence (${evidenceFor.length}):`);
  for (const e of evidenceFor) {
    console.log(`  - id=${e.id.substring(0, 8)} tier=${e.sourceAuthorityTier} src=${e.sourceUrlOrIdentifier}`);
  }
  const distinctSources = new Set(evidenceFor.map((e) => e.sourceUrlOrIdentifier)).size;
  console.log(`Distinct sources (by URL): ${distinctSources}`);

  const config = await modelRoutingConfigRepository.latestForAgent("Confidence");
  if (!config) throw new Error("no model_routing_config for Confidence");
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  const backendFacts: ConfidenceBackendFacts = {
    distinctSupportingSources: new Set(evidenceFor.map((e) => e.sourceUrlOrIdentifier)).size,
    distinctContradictingSources: 0,
    highestSupportingTier: highestAuthorityTier(evidenceFor),
    highestContradictingTier: null,
  };

  const result = await runConfidenceSandbox(llm, {
    hypothesisStatement: hypothesis.statement,
    evidenceFor,
    evidenceAgainst: [],
    backendFacts,
  });

  console.log("\n=== RAW MODEL RESPONSE ===");
  console.log(result.rawResponse);
  console.log("\n=== PARSED ===");
  console.log(JSON.stringify(result.parsed, null, 2));
  console.log("\n=== VALIDATION ERRORS ===");
  console.log(result.validationErrors);
  console.log("\n=== BOUNDED-RULE VIOLATIONS ===");
  console.log(result.boundedRuleViolations);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
