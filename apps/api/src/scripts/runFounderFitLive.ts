// Persistent runner for FounderFit Agent's live runs.
// Two modes:
//
//   default:  npx tsx -r dotenv/config src/scripts/runFounderFitLive.ts <candidateId>
//     Contract-compliant path. Looks up the OpportunityCandidate,
//     resolves the run's Founder, calls runFounderFitAgent. Writes
//     founder_fit_score + founder_fit_rationale on the candidate row
//     and inserts a fits/does_not_fit edge from founder to candidate.
//
//   preview:  npx tsx -r dotenv/config src/scripts/runFounderFitLive.ts --preview <hypothesisId>
//     No-write mode. Exists because Composition Agent hasn't shipped
//     yet in Phase 5 — there is no OpportunityCandidate to fit
//     against, so the contract path can't produce a result. Preview
//     synthesizes a FounderFitSandboxInput directly from the target
//     Hypothesis (plus the run's Founder), calls the sandbox live
//     against real NIM, and prints the result WITHOUT writing to
//     opportunity_candidate or edge. Useful to exercise the
//     reasoning pass live before Composition is up.
import { runFounderFitAgent } from "../agents/live/founderFitAgent";
import { runFounderFitSandbox, type FounderFitSandboxInput, type FounderEvidenceRecord } from "../sandbox/founderFitSandbox";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { founderRepository } from "../repositories/founder.repository";
import { founderEvidenceRepository } from "../repositories/founderEvidence.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

async function main() {
  const args = process.argv.slice(2);
  const previewIdx = args.indexOf("--preview");
  const previewMode = previewIdx !== -1;
  const positional = args.filter((a) => a !== "--preview");
  const targetId = positional[0];
  if (!targetId) {
    throw new Error(
      "usage:\n" +
        "  runFounderFitLive.ts <candidateId>\n" +
        "  runFounderFitLive.ts --preview <hypothesisId>"
    );
  }

  const run = await prisma.pipelineRun.findUnique({ where: { runId: RUN_ID } });
  if (!run) throw new Error(`pipeline_run ${RUN_ID} not found`);
  const founderId = run.founderId;

  const config = await modelRoutingConfigRepository.latestForAgent("FounderFit");
  if (!config) throw new Error("no model_routing_config found for FounderFit");
  console.log(`Using model: ${config.nimModelId} (tier: ${config.tier}, version: ${config.version})`);
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  if (previewMode) {
    await runPreview(targetId, founderId, llm);
  } else {
    await runContract(targetId, founderId, llm);
  }

  await prisma.$disconnect();
}

async function runContract(candidateId: string, founderId: string, llm: NimLLMClient) {
  console.log(`Contract-compliant mode. Target OpportunityCandidate: ${candidateId}, Founder: ${founderId}\n`);
  const result = await runFounderFitAgent(RUN_ID, candidateId, founderId, llm);
  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  if (!result.skipped) {
    const after = await prisma.opportunityCandidate.findUnique({ where: { id: candidateId } });
    console.log("\n=== CANDIDATE ROW AFTER ===");
    console.log(
      JSON.stringify(
        {
          id: after?.id,
          status: after?.status,
          founderFitScore: after?.founderFitScore,
          founderFitRationale: after?.founderFitRationale,
        },
        null,
        2
      )
    );
  }
}

async function runPreview(hypothesisId: string, founderId: string, llm: NimLLMClient) {
  console.log(`PREVIEW mode (no DB writes). Target Hypothesis: ${hypothesisId}, Founder: ${founderId}\n`);

  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: hypothesisId } });
  if (!hypothesis) throw new Error(`hypothesis ${hypothesisId} not found`);
  console.log(`Hypothesis statement:\n  ${hypothesis.statement}\n`);

  const [founder, founderEvidenceRows] = await Promise.all([
    founderRepository.findById(founderId),
    founderEvidenceRepository.findByFounderId(founderId),
  ]);
  if (!founder) throw new Error(`founder ${founderId} not found`);

  const founderEvidence: FounderEvidenceRecord[] = founderEvidenceRows.map((e) => ({
    id: e.id,
    targetField: e.targetField as FounderEvidenceRecord["targetField"],
    extractedValue: e.extractedValue,
    rawAnswer: e.rawAnswer,
  }));

  // Requirements summary synthesized directly from the hypothesis
  // (in the absence of a Composed OpportunityCandidate). This is
  // pragmatic scaffolding for preview mode ONLY — the contract path
  // uses composed Market + BusinessModel via
  // opportunity_candidate_composition per AI_AGENTS.md §9.
  const requirementsSummary =
    `Building a solution to this hypothesis requires deep Shopify subscription/checkout API integration (Shop Pay webhook handling, cancellation-event routing). Go-to-market requires reaching DTC subscription brand operators, competing with Recharge/Bold/Loop's existing footprints. ` +
    `Underlying hypothesis: ${hypothesis.statement}`;

  const sandboxInput: FounderFitSandboxInput = {
    founder: {
      id: founder.id,
      expertise: founder.expertise ?? [],
      distributionAssets: founder.distributionAssets ?? [],
      capitalAvailability: founder.capitalAvailability ?? null,
      founderEvidence,
      isLegacy: founderEvidence.length === 0,
    },
    opportunity: {
      label: `Hypothesis ${hypothesis.id.slice(0, 8)} preview`,
      requirementsSummary,
    },
  };

  console.log("=== FOUNDER PROFILE PASSED TO SANDBOX ===");
  console.log(JSON.stringify(sandboxInput.founder, null, 2));
  console.log("\n=== OPPORTUNITY SUMMARY PASSED TO SANDBOX ===");
  console.log(sandboxInput.opportunity.requirementsSummary);

  const result = await runFounderFitSandbox(llm, sandboxInput);

  console.log("\n=== RAW MODEL RESPONSE ===");
  console.log(result.rawResponse);
  console.log("\n=== PARSED ===");
  console.log(JSON.stringify(result.parsed, null, 2));
  console.log("\n=== VALIDATION ERRORS ===");
  console.log(result.validationErrors);
  console.log("\n=== BOUNDED-RULE VIOLATIONS ===");
  console.log(result.boundedRuleViolations);

  console.log("\n=== PREVIEW CONFIRMATION ===");
  console.log("  writes to opportunity_candidate: NONE");
  console.log("  writes to edge (fits/does_not_fit): NONE");
  console.log("  agent_execution_log row: NOT WRITTEN (preview bypasses the agent wrapper)");
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
