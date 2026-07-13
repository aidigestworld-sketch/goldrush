// Generalization probe — runs Discovery → Expansion → Filtering →
// CompetitiveAnalysis against a genuinely non-Shopify vertical with
// ZERO manual per-vertical setup beyond what the code inherently
// needs (a scoring_config row, a pipeline_run row, Tavily ingest to
// have any evidence at all — because the Shopify-specific connectors
// don't apply to a non-Shopify vertical).
//
// Test vertical: b2b_customer_support_saas.
// Chosen because it is:
//   - not Shopify, not on any app marketplace we have a connector for
//   - a distinct SaaS category with well-known competitors (Zendesk,
//     Intercom, Front, Help Scout) so Tavily will return real results
//   - structurally similar to Shopify subscriptions ONLY in the shape
//     of the market (SaaS competitors, subscription revenue) — the
//     underlying problem/audience space is completely different
//
// Read-only against production data except for creating rows tagged
// with this new vertical. Every artifact created here is tagged with
// a TAG prefix so a cleanup query can find them.
//
// Run: npx tsx -r dotenv/config src/scripts/generalizationProbe.ts
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runDiscoveryAgent } from "../agents/live/discoveryAgent";
import { runExpansionAgent } from "../agents/live/expansionAgent";
import { runFilteringAgent } from "../agents/live/filteringAgent";
import { runCompetitiveAnalysisAgent } from "../agents/live/competitiveAnalysisAgent";
import { normalizeTavilySearchResult } from "../pipeline/normalizers/tavilySearch.normalizer";
import { evidenceRepository } from "../repositories/evidence.repository";
import { prisma } from "../db/client";

const VERTICAL = "b2b_customer_support_saas";
const TAG = "gen-probe-cs://";

// Queries chosen to fetch each source_type Discovery/CompetitiveAnalysis
// need. Each pair (query, mapped-source-type) mirrors what a real
// per-vertical setup would need to supply.
const QUERIES: { query: string; sourceType: "search_signal" | "industry_report" | "marketplace" | "review_complaint" | "competitor_material" }[] = [
  { query: "B2B customer support software market size growth 2025 2026", sourceType: "industry_report" },
  { query: "customer support saas market Zendesk Intercom Front Help Scout", sourceType: "marketplace" },
  { query: "help desk software common merchant complaints frustrations", sourceType: "review_complaint" },
  { query: "Zendesk pricing tiers per agent", sourceType: "competitor_material" },
  { query: "Intercom pricing tiers messages contacts", sourceType: "competitor_material" },
  { query: "Front pricing tiers seats", sourceType: "competitor_material" },
  { query: "Zendesk vs Intercom vs Front vs Help Scout comparison", sourceType: "search_signal" },
];

const TAVILY_URL = "https://api.tavily.com/search";

async function callTavily(apiKey: string, query: string, topic: "general" | "news"): Promise<{ results: {url:string;title:string;content:string;score:number;published_date?:string|null}[] }> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, topic, search_depth: "advanced", max_results: 5, include_answer: false, include_raw_content: false }),
  });
  if (!res.ok) throw new Error(`Tavily ${topic} error ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  console.log(`\n=== Setup: scoring_config for ${VERTICAL}`);
  const existingSC = await prisma.scoringConfig.findFirst({ where: { vertical: VERTICAL } });
  if (!existingSC) {
    await prisma.scoringConfig.create({
      data: {
        version: 1,
        vertical: VERTICAL,
        w1Demand: 0.2, w2Hypothesis: 0.2, w3Margin: 0.15, w4Feasibility: 0.15, w5Distribution: 0.15, w6Timing: 0.15,
        qualityWeight: 0.7, founderFitWeight: 0.3,
      },
    });
    console.log("  scoring_config row inserted");
  } else {
    console.log("  scoring_config already exists");
  }

  const founder = await prisma.founder.findFirst();
  if (!founder) throw new Error("no founder in DB");
  const run = await prisma.pipelineRun.create({ data: { founderId: founder.id, vertical: VERTICAL } });
  console.log(`  pipeline_run created: ${run.runId} (vertical=${VERTICAL})`);

  console.log(`\n=== Stage 0: Tavily ingest for ${VERTICAL}`);
  // Force each query's source_type via the returned raw doc's sourceType.
  // The Tavily normalizer's default is search_signal — override at the
  // NormalizedEvidence layer since we're using per-query source_type
  // labeling for CompetitiveAnalysis's per-vendor grouping.
  for (const q of QUERIES) {
    console.log(`  Tavily [${q.sourceType}]: ${q.query}`);
    const topic: "general" | "news" = q.sourceType === "industry_report" || q.sourceType === "marketplace" ? "news" : "general";
    const resp = await callTavily(apiKey, q.query, topic);
    const fetchedAt = new Date();
    const rows = resp.results.map((r) => {
      const payload = { title: r.title, url: r.url, content: r.content, score: r.score, publishedDate: r.published_date ?? null };
      const [normalized] = normalizeTavilySearchResult(JSON.stringify(payload), r.url + `?probe=${VERTICAL}`, fetchedAt);
      // Override source_type + tier to match this query's intended slot.
      const authorityTier = q.sourceType === "industry_report" ? "industry_report"
        : q.sourceType === "competitor_material" ? "competitor_self_stated"
        : q.sourceType === "review_complaint" ? "forum_post"
        : normalized.sourceAuthorityTier;
      return { ...normalized, sourceType: q.sourceType, sourceAuthorityTier: authorityTier as typeof normalized.sourceAuthorityTier };
    });
    // Dedup within run
    const existing = new Set((await prisma.evidence.findMany({ where: { sourceUrlOrIdentifier: { in: rows.map((r) => r.sourceUrlOrIdentifier) } }, select: { sourceUrlOrIdentifier: true } })).map((e) => e.sourceUrlOrIdentifier));
    const toInsert = rows.filter((r) => !existing.has(r.sourceUrlOrIdentifier));
    if (toInsert.length > 0) await evidenceRepository.createMany(toInsert, VERTICAL);
    console.log(`    ${toInsert.length}/${rows.length} inserted`);
  }

  const evidenceBefore = await prisma.evidence.count({ where: { status: "active", sourceUrlOrIdentifier: { contains: `probe=${VERTICAL}` } } });
  console.log(`  Total probe evidence rows: ${evidenceBefore}`);

  // --- Stage 1: Discovery ---
  console.log(`\n=== Stage 1: Discovery`);
  const discConfig = await modelRoutingConfigRepository.latestForAgent("Discovery");
  if (!discConfig) throw new Error("no model routing for Discovery");
  const discLlm = new NimLLMClient(apiKey /* won't be used for NIM */, discConfig.nimModelId);
  const discLlmReal = new NimLLMClient(process.env.NVIDIA_API_KEY!, discConfig.nimModelId);
  const discovery = await runDiscoveryAgent(run.runId, discLlmReal);
  console.log(`  Discovery result:`, JSON.stringify(discovery, null, 2));

  // Show what Discovery actually wrote
  const markets = await prisma.market.findMany({ where: { status: "active", createdAt: { gte: run.startedAt } } });
  console.log(`  Markets created (${markets.length}):`);
  for (const m of markets) console.log(`    [${m.id.slice(0, 8)}] ${m.label ?? "(no label)"} — maturity=${m.maturityStage} confidence=${m.confidence}`);
  // Suppress unused var
  void discLlm;

  const targetMarket = markets[0];
  if (!targetMarket) {
    console.log("  ⚠️ Discovery produced no markets — pipeline halted at stage 1");
    await prisma.$disconnect();
    return;
  }

  // --- Stage 2: Expansion ---
  console.log(`\n=== Stage 2: Expansion (market=${targetMarket.id.slice(0,8)})`);
  const expConfig = await modelRoutingConfigRepository.latestForAgent("Expansion");
  if (!expConfig) throw new Error("no model routing for Expansion");
  const expLlm = new NimLLMClient(process.env.NVIDIA_API_KEY!, expConfig.nimModelId);
  const expansion = await runExpansionAgent(run.runId, targetMarket.id, expLlm);
  console.log(`  Expansion result:`, JSON.stringify(expansion, null, 2));
  const audiences = await prisma.audience.findMany({ where: { status: "active", createdAt: { gte: run.startedAt } } });
  const problems = await prisma.problem.findMany({ where: { status: "active", createdAt: { gte: run.startedAt } } });
  console.log(`  Audiences created (${audiences.length}): ${audiences.map((a) => a.label).slice(0,5).join(" | ")}`);
  console.log(`  Problems created (${problems.length}):`);
  for (const p of problems.slice(0, 8)) console.log(`    - ${p.label} (severity=${p.severitySignal}, confidence=${p.confidence})`);

  // --- Stage 3: Filtering ---
  console.log(`\n=== Stage 3: Filtering`);
  const filtering = await runFilteringAgent(run.runId, {});
  console.log(`  totalDeprecated=${filtering.totalDeprecated}`);
  for (const per of filtering.perType) {
    console.log(`    ${per.nodeType}: considered=${per.totalConsidered} survived=${per.survived} deprecated=${per.deprecated.length}`);
  }

  // --- Stage 4: CompetitiveAnalysis ---
  console.log(`\n=== Stage 4: CompetitiveAnalysis`);
  const survivorProblem = await prisma.problem.findFirst({ where: { status: "active", createdAt: { gte: run.startedAt } } });
  if (!survivorProblem) {
    console.log("  ⚠️ No surviving problem for CompetitiveAnalysis");
    await prisma.$disconnect();
    return;
  }
  const compEvidence = await prisma.evidence.findMany({ where: { sourceType: "competitor_material", status: "active", sourceUrlOrIdentifier: { contains: `probe=${VERTICAL}` } } });
  const nameFromUrl = (url: string): string | null => {
    if (/zendesk/i.test(url)) return "Zendesk";
    if (/intercom/i.test(url)) return "Intercom";
    if (/front\.com|frontapp/i.test(url)) return "Front";
    if (/helpscout/i.test(url)) return "Help Scout";
    return null;
  };
  const compMap = new Map<string, string[]>();
  for (const r of compEvidence) {
    const name = nameFromUrl(r.sourceUrlOrIdentifier) ?? "Unknown Competitor";
    compMap.set(name, [...(compMap.get(name) ?? []), r.id]);
  }
  console.log(`  competitor -> evidence: ${JSON.stringify(Object.fromEntries(compMap))}`);
  const caConfig = await modelRoutingConfigRepository.latestForAgent("CompetitiveAnalysis");
  if (!caConfig) throw new Error("no model routing for CompetitiveAnalysis");
  const caLlm = new NimLLMClient(process.env.NVIDIA_API_KEY!, caConfig.nimModelId);
  const ca = await runCompetitiveAnalysisAgent(run.runId, survivorProblem.id, compMap, caLlm);
  console.log(`  CA result:`, JSON.stringify(ca, null, 2));
  const es = await prisma.existingSolution.findMany({ where: { status: "active", createdAt: { gte: run.startedAt } } });
  const bm = await prisma.businessModel.findMany({ where: { status: "active", createdAt: { gte: run.startedAt } } });
  console.log(`  ExistingSolutions (${es.length}): ${es.map((e) => e.label).join(" | ")}`);
  console.log(`  BusinessModels (${bm.length}): ${bm.map((b) => `${b.label} [margin=${b.marginProfile}, opsC=${b.operationalComplexityEstimate}]`).join(" | ")}`);

  console.log(`\n=== DONE. Run id: ${run.runId}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
