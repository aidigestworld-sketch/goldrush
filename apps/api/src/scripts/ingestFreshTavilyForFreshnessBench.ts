// Triggers a small, tightly-scoped Tavily search + normalize + persist
// cycle for the purpose of verifying migration 007's source_published_at
// plumbing end-to-end and giving the freshness bench something with
// real temporal spread to measure.
//
// Not a general-purpose ingest runner — the questions were hand-picked
// to hit sources of very different vintages (a mix of ~2024/2023
// analyses that should carry publish dates, and recent 2026 news that
// should also carry a date). The point is measurable spread, not new
// evidence for any hypothesis.
//
// Runs OUTSIDE of runId/hypothesis wiring — this bypasses Validation
// Agent entirely and calls the normalizer path directly through the
// Tavily client. That's on purpose: we don't want Validation
// classifying anything, we just want fresh evidence rows with the
// new column populated so we can bench.
//
// Run: npx tsx -r dotenv/config src/scripts/ingestFreshTavilyForFreshnessBench.ts
import { normalizeTavilySearchResult } from "../pipeline/normalizers/tavilySearch.normalizer";
import { evidenceRepository } from "../repositories/evidence.repository";
import { prisma } from "../db/client";

// EMPIRICAL FINDING from investigating this task's step 4: Tavily's
// default `topic="general"` search does NOT populate `published_date`
// in its response for the queries this project cares about (verified
// against 3 sample queries during this session — 0/15 results had a
// non-null published_date). The field IS defined in the API contract
// and Tavily DOES return it when the source page carries a clearly-
// parseable date, but "general" topic pulls a lot of vendor/blog
// pages where Tavily either can't extract the date or chooses not to.
//
// `topic="news"` reliably populates published_date for every result
// (verified same session, 3/3 results had it) but shifts the search
// toward news sources, which is off-topic for the opportunity-research
// use case Validation Collector normally runs. So this bench script
// runs BOTH modes and reports each — the point is to verify the
// plumbing works end-to-end and to give the freshness formula
// something with real spread to score, not to pretend news is our
// default ingest mode.
const QUERIES: string[] = [
  "history of Shopify subscription apps 2019 2020 evolution",
  "Recharge Skio acquisition news April 2026",
  "subscription churn benchmarks 2024 industry report",
];

const TAVILY_URL = "https://api.tavily.com/search";

interface TavilyResp {
  results: {
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string | null;
  }[];
}

async function callTavily(
  apiKey: string,
  query: string,
  topic: "general" | "news"
): Promise<TavilyResp> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      topic,
      search_depth: "advanced",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${topic} error ${res.status}: ${await res.text()}`);
  return (await res.json()) as TavilyResp;
}

async function runOne(apiKey: string, query: string, topic: "general" | "news") {
  console.log(`\n=== [topic=${topic}] ${query}`);
  const resp = await callTavily(apiKey, query, topic);
  const fetchedAt = new Date();
  const normalized = resp.results.flatMap((r) => {
    const payload = { title: r.title, url: r.url, content: r.content, score: r.score, publishedDate: r.published_date ?? null };
    return normalizeTavilySearchResult(JSON.stringify(payload), r.url, fetchedAt);
  });

  const deduped = normalized.filter(
    (row, i, arr) => arr.findIndex((r) => r.sourceUrlOrIdentifier === row.sourceUrlOrIdentifier) === i
  );
  const existingUrls = new Set(
    (
      await prisma.evidence.findMany({
        where: { sourceUrlOrIdentifier: { in: deduped.map((d) => d.sourceUrlOrIdentifier) } },
        select: { sourceUrlOrIdentifier: true },
      })
    ).map((r) => r.sourceUrlOrIdentifier)
  );
  const toInsert = deduped.filter((d) => !existingUrls.has(d.sourceUrlOrIdentifier));
  const withDateNow = toInsert.filter((r) => r.sourcePublishedAt !== null).length;
  console.log(`  ${toInsert.length} new (${withDateNow} with source_published_at); ${existingUrls.size} dedup skipped`);

  if (toInsert.length > 0) await evidenceRepository.createMany(toInsert, "shopify_subscriptions");
  return { inserted: toInsert.length, withDate: withDateNow };
}

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  let totalInserted = 0;
  let totalWithDate = 0;

  for (const query of QUERIES) {
    const g = await runOne(apiKey, query, "general");
    totalInserted += g.inserted; totalWithDate += g.withDate;
  }
  // News-topic run for the same queries — this is what actually
  // exercises the sourcePublishedAt plumbing end-to-end, since Tavily
  // reliably returns published_date under topic="news".
  for (const query of QUERIES) {
    const n = await runOne(apiKey, query, "news");
    totalInserted += n.inserted; totalWithDate += n.withDate;
  }

  console.log(`\n=== TOTAL: ${totalInserted} new rows, ${totalWithDate} with source_published_at`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
