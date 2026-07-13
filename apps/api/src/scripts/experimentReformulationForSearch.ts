// Bench comparison: does replacing the raw hypothesis statement with
// an LLM-reformulated mechanism-specific yes/no question measurably
// improve Tavily's first-party-competitor result yield?
//
// STATUS UPDATE (post-decision): this bench's finding — reformulated
// query surfaces a mostly-disjoint result pool with roughly double
// the competitor-naming rate — led to shipping BOTH queries per
// hypothesis in production (searchForHypothesisEvidence.ts). This
// script is retained as a reproducible way to inspect the raw
// side-by-side comparison and to sanity-check the reformulation
// utility's output on a fresh hypothesis before hypothetically
// promoting an allowlist-like list of actors from it.
//
// This bench NOW imports the production reformulation utility
// (pipeline/reformulateHypothesisQuestion.ts) rather than
// duplicating the prompt — one source of truth for the reformulation
// prompt, whether it's called from Validation Collector's search
// path or from this bench.
//
// No DB writes. No pipeline_search_log entries (TavilyClient used
// directly, bypassing searchForHypothesisEvidence's persist path).
//
// Run: npx tsx -r dotenv/config src/scripts/experimentReformulationForSearch.ts <hypothesisId>
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { TavilyClient, type TavilySearchResult } from "../pipeline/tavilyClient";
import { reformulateHypothesisQuestion } from "../pipeline/reformulateHypothesisQuestion";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { prisma } from "../db/client";

// Same allowlist that tavilySearch.normalizer.ts already uses for
// tier upgrades — kept in sync intentionally: "first-party
// competitor" here means the same thing normalization uses to tag
// competitor_self_stated.
const FIRST_PARTY_COMPETITOR_DOMAINS: readonly string[] = [
  "getrecharge.com",
  "boldcommerce.com",
  "loopwork.co",
];

// Named competitors — for the "URL/title mentions a named competitor
// without being on their own domain" check. This is a secondary tag
// for third-party comparison / mention pages.
const COMPETITOR_NAME_PATTERN = /\b(recharge|bold\s*subscription|bold\s*commerce|loop\s*subscription|loopwork)\b/i;

type ResultCategory = "first-party" | "names-competitor" | "generic";

function categorize(result: TavilySearchResult): ResultCategory {
  let host = "";
  try {
    host = new URL(result.url).hostname.toLowerCase();
  } catch {
    // fall through
  }
  const isFirstParty = FIRST_PARTY_COMPETITOR_DOMAINS.some(
    (d) => host === d || host.endsWith(`.${d}`)
  );
  if (isFirstParty) return "first-party";

  const namesCompetitor =
    COMPETITOR_NAME_PATTERN.test(result.url) || COMPETITOR_NAME_PATTERN.test(result.title);
  if (namesCompetitor) return "names-competitor";

  return "generic";
}

interface CategorizedResult {
  category: ResultCategory;
  url: string;
  title: string;
  score: number;
}

async function runQuery(tavily: TavilyClient, query: string): Promise<CategorizedResult[]> {
  const response = await tavily.search(query, { searchDepth: "advanced", maxResults: 10 });
  return response.results.map((r) => ({
    category: categorize(r),
    url: r.url,
    title: r.title,
    score: r.score,
  }));
}

function countByCategory(results: CategorizedResult[]): Record<ResultCategory, number> {
  const counts: Record<ResultCategory, number> = { "first-party": 0, "names-competitor": 0, generic: 0 };
  for (const r of results) counts[r.category]++;
  return counts;
}

function printResultTable(label: string, results: CategorizedResult[]): void {
  console.log(`\n=== ${label} ===`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const badge =
      r.category === "first-party" ? "[FIRST-PARTY]" : r.category === "names-competitor" ? "[NAMES-COMPETITOR]" : "[generic]";
    console.log(`${(i + 1).toString().padStart(2)}. ${badge} score=${r.score.toFixed(2)} ${r.url}`);
    console.log(`      ${r.title}`);
  }
  const counts = countByCategory(results);
  console.log(
    `  totals: first-party=${counts["first-party"]}, names-competitor=${counts["names-competitor"]}, generic=${counts.generic}`
  );
}

async function main() {
  const hypothesisId = process.argv[2];
  if (!hypothesisId) throw new Error("usage: experimentReformulationForSearch.ts <hypothesisId>");

  const hypothesis = await prisma.hypothesis.findUnique({ where: { id: hypothesisId } });
  if (!hypothesis) throw new Error(`no hypothesis ${hypothesisId}`);

  console.log(`Hypothesis: ${hypothesis.id}`);
  console.log(`Statement:\n  ${hypothesis.statement}\n`);

  const validationConfig = await modelRoutingConfigRepository.latestForAgent("Validation");
  if (!validationConfig) throw new Error("no model_routing_config for Validation");
  const nvidiaKey = process.env.NVIDIA_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!nvidiaKey) throw new Error("NVIDIA_API_KEY not set");
  if (!tavilyKey) throw new Error("TAVILY_API_KEY not set");

  const llm = new NimLLMClient(nvidiaKey, validationConfig.nimModelId);
  const reformulated = await reformulateHypothesisQuestion(llm, hypothesis.statement);
  console.log(`Reformulated question (LLM: ${validationConfig.nimModelId}):\n  ${reformulated}\n`);

  const tavily = new TavilyClient(tavilyKey);
  const [rawResults, reformulatedResults] = await Promise.all([
    runQuery(tavily, hypothesis.statement),
    runQuery(tavily, reformulated),
  ]);

  printResultTable("RAW STATEMENT QUERY", rawResults);
  printResultTable("REFORMULATED QUESTION QUERY", reformulatedResults);

  const rawCounts = countByCategory(rawResults);
  const refCounts = countByCategory(reformulatedResults);

  console.log("\n=== COMPARISON ===");
  console.log(
    `first-party        raw=${rawCounts["first-party"]}   reformulated=${refCounts["first-party"]}   delta=${refCounts["first-party"] - rawCounts["first-party"]}`
  );
  console.log(
    `names-competitor   raw=${rawCounts["names-competitor"]}   reformulated=${refCounts["names-competitor"]}   delta=${refCounts["names-competitor"] - rawCounts["names-competitor"]}`
  );
  console.log(
    `generic            raw=${rawCounts.generic}   reformulated=${refCounts.generic}   delta=${refCounts.generic - rawCounts.generic}`
  );
  const rawTotalNamed = rawCounts["first-party"] + rawCounts["names-competitor"];
  const refTotalNamed = refCounts["first-party"] + refCounts["names-competitor"];
  console.log(`\ntotal competitor-naming    raw=${rawTotalNamed}/10   reformulated=${refTotalNamed}/10`);

  const rawUrls = new Set(rawResults.map((r) => r.url));
  const refUrls = new Set(reformulatedResults.map((r) => r.url));
  const overlap = [...rawUrls].filter((u) => refUrls.has(u)).length;
  console.log(`URL overlap between the two result sets: ${overlap}/10`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
