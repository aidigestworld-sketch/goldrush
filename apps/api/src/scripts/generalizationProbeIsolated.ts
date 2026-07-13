// Follow-up isolation probe: feed Discovery ONLY the fresh-vertical
// evidence and see what the LLM produces. This isolates the question
// "can Discovery generalize to a new vertical?" from the separate
// question "does the runtime scope evidence per run?" — which the
// first probe already answered (it does NOT — findMany is global).
//
// Runs the SANDBOX directly (not the live agent wrapper) so we skip
// the DB-write path and just look at the LLM's raw judgment.
//
// Run: npx tsx -r dotenv/config src/scripts/generalizationProbeIsolated.ts
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runDiscoverySandbox } from "../sandbox/discoverySandbox";
import { runExpansionSandbox } from "../sandbox/expansionSandbox";
import { runCompetitiveAnalysisSandbox } from "../sandbox/competitiveAnalysisSandbox";
import { prisma } from "../db/client";

const VERTICAL = "b2b_customer_support_saas";

async function main() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY missing");

  // Fetch ONLY the fresh probe evidence (tagged in URL with `probe=<VERTICAL>`).
  const probeRows = await prisma.evidence.findMany({
    where: { status: "active", sourceUrlOrIdentifier: { contains: `probe=${VERTICAL}` } },
  });
  console.log(`probe evidence rows: ${probeRows.length}`);

  const bySrc = new Map<string, typeof probeRows>();
  for (const r of probeRows) {
    const key = r.sourceType;
    bySrc.set(key, [...(bySrc.get(key) ?? []), r]);
  }
  console.log("by source_type:", Object.fromEntries([...bySrc.entries()].map(([k, v]) => [k, v.length])));

  // ---- Discovery: feed the sandbox only the allowed source types ----
  console.log("\n=== Discovery (customer-support-only) ===");
  const discEvidence = probeRows.filter((r) => ["search_signal", "marketplace", "industry_report", "financial_signal"].includes(r.sourceType));
  console.log(`  feeding ${discEvidence.length} rows`);
  const discConfig = await modelRoutingConfigRepository.latestForAgent("Discovery");
  if (!discConfig) throw new Error("no Discovery model config");
  const discLlm = new NimLLMClient(apiKey, discConfig.nimModelId);
  const discoveryOut = await runDiscoverySandbox(discLlm, discEvidence.map((r) => ({ id: r.id, sourceType: r.sourceType as "search_signal"|"marketplace"|"industry_report"|"financial_signal", text: r.extractedFact })));
  console.log("  parsed markets:", discoveryOut.parsed?.markets.length ?? "NONE");
  console.log("  validationErrors:", discoveryOut.validationErrors);
  console.log("  boundedRuleViolations:", discoveryOut.boundedRuleViolations);
  if (discoveryOut.parsed?.markets) {
    for (const m of discoveryOut.parsed.markets) {
      console.log(`    - "${m.label}" (${m.maturity_stage}, conf=${m.confidence}, tags=${JSON.stringify(m.category_tags)})`);
    }
  }
  if (!discoveryOut.parsed) {
    console.log("  raw response (first 500 chars):", discoveryOut.rawResponse.slice(0, 500));
  }

  // ---- Expansion: feed the sandbox review_complaint evidence + note
  // that the SYSTEM_PROMPT is hardcoded to say "Shopify subscription
  // & recurring-order apps" ----
  console.log("\n=== Expansion (customer-support-only) ===");
  const expEvidence = probeRows.filter((r) => r.sourceType === "review_complaint");
  console.log(`  feeding ${expEvidence.length} review_complaint rows`);
  const expConfig = await modelRoutingConfigRepository.latestForAgent("Expansion");
  if (!expConfig) throw new Error("no Expansion model config");
  const expLlm = new NimLLMClient(apiKey, expConfig.nimModelId);
  const expansionMarketLabel = discoveryOut.parsed?.markets[0]?.label ?? VERTICAL;
  console.log(`  market label for prompt: "${expansionMarketLabel}"`);
  const expansionOut = await runExpansionSandbox(expLlm, expEvidence.map((r) => ({ id: r.id, sourceType: "review_complaint" as const, text: r.extractedFact })), expansionMarketLabel);
  console.log("  parsed audiences:", expansionOut.parsed?.audiences.length ?? "NONE");
  console.log("  parsed problems:", expansionOut.parsed?.problems.length ?? "NONE");
  console.log("  boundedRuleViolations:", expansionOut.boundedRuleViolations);
  if (expansionOut.parsed?.problems) {
    for (const p of expansionOut.parsed.problems.slice(0, 6)) {
      console.log(`    - Problem: "${p.label}" severity=${p.severity_signal} freq=${p.frequency_signal}`);
    }
  }
  if (expansionOut.parsed?.audiences) {
    for (const a of expansionOut.parsed.audiences.slice(0, 4)) {
      console.log(`    - Audience: "${a.label}"`);
    }
  }

  // ---- CompetitiveAnalysis: same prompt is fully vertical-agnostic ---
  console.log("\n=== CompetitiveAnalysis (customer-support) ===");
  const compEvidence = probeRows.filter((r) => r.sourceType === "competitor_material");
  console.log(`  feeding ${compEvidence.length} competitor_material rows`);
  const nameFromUrl = (url: string): string | null => {
    if (/zendesk/i.test(url)) return "Zendesk";
    if (/intercom/i.test(url)) return "Intercom";
    if (/front\.com|frontapp/i.test(url)) return "Front";
    if (/helpscout/i.test(url)) return "Help Scout";
    return null;
  };
  const caConfig = await modelRoutingConfigRepository.latestForAgent("CompetitiveAnalysis");
  if (!caConfig) throw new Error("no CompetitiveAnalysis model config");
  const caLlm = new NimLLMClient(apiKey, caConfig.nimModelId);
  const caOut = await runCompetitiveAnalysisSandbox(caLlm, compEvidence.map((r) => ({ id: r.id, competitorName: nameFromUrl(r.sourceUrlOrIdentifier) ?? "Unknown", sourceType: "competitor_material" as const, text: r.extractedFact })));
  console.log("  parsed existing_solutions:", caOut.parsed?.existing_solutions.length ?? "NONE");
  console.log("  parsed business_models:", caOut.parsed?.business_models.length ?? "NONE");
  console.log("  boundedRuleViolations:", caOut.boundedRuleViolations);
  if (caOut.parsed?.existing_solutions) {
    for (const es of caOut.parsed.existing_solutions) {
      console.log(`    - ES: "${es.label}" — positioning: ${es.positioning_summary?.slice(0, 100) ?? "(none)"}`);
    }
  }
  if (caOut.parsed?.business_models) {
    for (const bm of caOut.parsed.business_models) {
      console.log(`    - BM: competitor=${bm.competitor_label} type=${bm.model_type} evidence=${bm.evidence_refs.length}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
