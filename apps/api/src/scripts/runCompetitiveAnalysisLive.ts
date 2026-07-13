// Permanent, reusable runner for CompetitiveAnalysis Agent's live
// runs against real NIM + real Postgres. Previously this kind of
// script was written inline/ad-hoc per session and deleted afterward
// — that turned out to be a real problem: a fresh Claude Code session
// has no memory of a prior session's throwaway work, so "re-invoke the
// runner" became unresolvable once the session changed. This file
// exists so that never happens again for this agent.
//
// Run: npx tsx -r dotenv/config src/scripts/runCompetitiveAnalysisLive.ts [problemId]
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runCompetitiveAnalysisAgent } from "../agents/live/competitiveAnalysisAgent";
import { prisma } from "../db/client";

// Same runId used throughout this project's Phase 4 work — reusing it
// keeps every agent execution log entry for this whole exploratory
// sequence under one pipeline_run, which is what actually happened.
const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";

// Maps a seeded evidence row's sourceUrlOrIdentifier to a competitor
// name — matches the URL patterns from
// 006_competitive_analysis_evidence_seed.ts exactly.
function competitorNameFromUrl(url: string): string | null {
  if (url.includes("recharge")) return "Recharge";
  if (url.includes("loop-subscriptions")) return "Loop Subscriptions";
  if (url.includes("bold-subscriptions")) return "Bold Subscriptions";
  return null;
}

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

  const evidenceRows = await prisma.evidence.findMany({
    where: { sourceType: "competitor_material", status: "active" },
  });
  if (evidenceRows.length === 0) {
    throw new Error(
      "no active competitor_material evidence found — run " +
        "006_competitive_analysis_evidence_seed.ts first"
    );
  }

  const competitorNamesToEvidenceIds = new Map<string, string[]>();
  for (const row of evidenceRows) {
    const name = competitorNameFromUrl(row.sourceUrlOrIdentifier);
    if (!name) {
      console.warn(`WARNING: could not map evidence ${row.id} (${row.sourceUrlOrIdentifier}) to a known competitor — skipping`);
      continue;
    }
    const existing = competitorNamesToEvidenceIds.get(name) ?? [];
    existing.push(row.id);
    competitorNamesToEvidenceIds.set(name, existing);
  }
  console.log(
    "Competitor -> evidence mapping:",
    Object.fromEntries(competitorNamesToEvidenceIds)
  );

  const config = await modelRoutingConfigRepository.latestForAgent("CompetitiveAnalysis");
  if (!config) throw new Error("no model_routing_config found for CompetitiveAnalysis");
  console.log(`Using model: ${config.nimModelId} (tier: ${config.tier}, version: ${config.version})`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  const llm = new NimLLMClient(apiKey, config.nimModelId);

  const result = await runCompetitiveAnalysisAgent(RUN_ID, problem.id, competitorNamesToEvidenceIds, llm);
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
