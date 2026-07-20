// Per-vertical evidence bootstrap. Runs a small, fixed set of Tavily
// queries for a given vertical, normalizes the results via the same
// tavilySearch.normalizer.ts path Validation uses, and inserts the
// rows into the Evidence table tagged with that vertical.
//
// Solves the cold-start trap: Discovery reads Evidence and skips if
// empty, and Validation's active-search step (the only agent-side
// path that adds Evidence) is downstream of Discovery — so a vertical
// with zero rows can never bootstrap itself through the normal DAG.
// This script is the deliberate out-of-band seeder that unsticks a
// fresh vertical exactly once; after that, Validation's per-run
// Tavily loop takes over and the corpus accumulates organically.
//
// Runs OUTSIDE runId/hypothesis wiring — no Validation classification,
// no node_source_refs. Just: query → normalize → insert. That's on
// purpose; the run that consumes these rows is the founder's next
// real orchestration.
//
// Run: npx tsx --env-file=.env src/scripts/bootstrapVerticalEvidence.ts <vertical>
//   e.g. npx tsx --env-file=.env src/scripts/bootstrapVerticalEvidence.ts b2b_customer_support_saas
//
// URL-based dedup against the existing Evidence table prevents this
// from double-inserting when re-run — safe to invoke repeatedly.
import { normalizeTavilySearchResult } from "../pipeline/normalizers/tavilySearch.normalizer";
import { evidenceRepository } from "../repositories/evidence.repository";
import { prisma } from "../db/client";
import { ALLOWED_VERTICALS, type Vertical } from "../orchestrator/verticals";

// Per-vertical seed queries. Kept in-source rather than externalized
// because the queries themselves are the interesting spec — a vertical
// gets bootstrapped by a *specific* set of authored search prompts,
// and reviewing that set is part of reviewing the seed.
//
// sourceType defaults to "search_signal" (what Discovery reads). Setting
// it to "review_complaint" makes the row feed Expansion instead —
// same post-normalization override pattern generalizationProbe.ts:97-103
// used historically for this vertical (see comment there: the Tavily
// normalizer hardcodes search_signal, so we relabel at the
// NormalizedEvidence layer). Content is still real Tavily-returned
// pages; only the taxonomy slot changes.
interface QuerySpec {
  query: string;
  sourceType?: "search_signal" | "review_complaint" | "competitor_material";
}

const VERTICAL_QUERIES: Record<Vertical, QuerySpec[]> = {
  shopify_subscriptions: [
    { query: "history of Shopify subscription apps 2019 2020 evolution" },
    { query: "Recharge Skio acquisition news April 2026" },
    { query: "subscription churn benchmarks 2024 industry report" },
  ],
  b2b_customer_support_saas: [
    { query: "B2B customer support SaaS market size growth 2026" },
    { query: "help desk software industry trends 2025" },
    { query: "Zendesk Intercom Freshdesk Gorgias competitive landscape" },
    { query: "AI customer support automation enterprise adoption 2026" },
    { query: "customer support platform pricing benchmarks B2B" },
    // review_complaint slot — feeds Expansion, not Discovery.
    { query: "help desk software common complaints frustrations pain points", sourceType: "review_complaint" },
    { query: "Zendesk Intercom Freshdesk customer support tool user complaints reviews", sourceType: "review_complaint" },
    { query: "customer support saas problems user complaints reddit", sourceType: "review_complaint" },
    { query: "b2b customer service software what users hate reviews", sourceType: "review_complaint" },
    // competitor_material slot — feeds Competitive Analysis. URLs MUST
    // contain one of: zendesk / intercom / front.com / frontapp /
    // freshdesk / freshworks / helpscout / help-scout / gorgias — or
    // handlers.ts:competitorNameFromUrl returns null and the row is
    // silently dropped from CA's input map (see handlers.ts:334-347).
    // Queries are competitor-name-forward so Tavily preferentially
    // returns the vendor's own product pages + G2/Capterra profiles
    // (which also contain the vendor name as a URL substring).
    { query: "Zendesk pricing plans tiers per agent features 2026", sourceType: "competitor_material" },
    { query: "Intercom pricing tiers messages conversations plans", sourceType: "competitor_material" },
    { query: "Front.com collaborative inbox pricing plans features", sourceType: "competitor_material" },
    { query: "Freshdesk pricing tiers support features Freshworks", sourceType: "competitor_material" },
    { query: "Help Scout pricing plans features customer support", sourceType: "competitor_material" },
    { query: "Gorgias pricing tiers features ecommerce customer support", sourceType: "competitor_material" },
  ],
};

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

async function callTavily(apiKey: string, query: string): Promise<TavilyResp> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "advanced",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}: ${await res.text()}`);
  return (await res.json()) as TavilyResp;
}

async function runOne(apiKey: string, vertical: Vertical, spec: QuerySpec) {
  const sourceType = spec.sourceType ?? "search_signal";
  console.log(`\n=== [${vertical}] [${sourceType}] ${spec.query}`);
  const resp = await callTavily(apiKey, spec.query);
  const fetchedAt = new Date();
  // For non-search_signal queries, suffix the stored URL so a page that
  // also appears in a search_signal query can coexist under both slots.
  // Same trick generalizationProbe.ts:97 used (?probe=<vertical>).
  //
  // Note: CA's handlers.ts:competitorNameFromUrl does substring matching
  // on the URL, so the ?bootstrap= query-string suffix does NOT hide
  // the competitor name from the matcher — "https://www.zendesk.com/pricing?bootstrap=competitor_material"
  // still contains "zendesk".
  const urlSuffix =
    sourceType === "review_complaint" ? "?bootstrap=review_complaint"
    : sourceType === "competitor_material" ? "?bootstrap=competitor_material"
    : "";
  const normalized = resp.results.flatMap((r) => {
    const payload = { title: r.title, url: r.url, content: r.content, score: r.score, publishedDate: r.published_date ?? null };
    const rows = normalizeTavilySearchResult(JSON.stringify(payload), r.url + urlSuffix, fetchedAt);
    // Post-normalization override: normalizeTavilySearchResult hardcodes
    // sourceType='search_signal'. Relabel per the query's intended slot.
    // Authority tier matches generalizationProbe.ts:99-102's choices:
    // forum_post for review_complaint, competitor_self_stated for
    // competitor_material.
    if (sourceType === "review_complaint") {
      return rows.map((row) => ({
        ...row,
        sourceType: "review_complaint" as const,
        sourceAuthorityTier: "forum_post" as const,
      }));
    }
    if (sourceType === "competitor_material") {
      return rows.map((row) => ({
        ...row,
        sourceType: "competitor_material" as const,
        sourceAuthorityTier: "competitor_self_stated" as const,
      }));
    }
    return rows;
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

  if (toInsert.length > 0) await evidenceRepository.createMany(toInsert, vertical);
  return { inserted: toInsert.length, withDate: withDateNow };
}

async function main() {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  const rawVertical = process.argv[2];
  if (!rawVertical) {
    throw new Error(
      `usage: bootstrapVerticalEvidence.ts <vertical>\n  allowed: ${ALLOWED_VERTICALS.join(", ")}`
    );
  }
  if (!(ALLOWED_VERTICALS as readonly string[]).includes(rawVertical)) {
    throw new Error(
      `unknown vertical "${rawVertical}" — allowed: ${ALLOWED_VERTICALS.join(", ")}`
    );
  }
  const vertical = rawVertical as Vertical;
  const queries = VERTICAL_QUERIES[vertical];
  if (!queries || queries.length === 0) {
    throw new Error(`no seed queries defined for vertical "${vertical}" — add them to VERTICAL_QUERIES`);
  }

  console.log(`[bootstrap] vertical=${vertical}  queries=${queries.length}`);

  let totalInserted = 0;
  let totalWithDate = 0;
  for (const spec of queries) {
    const r = await runOne(apiKey, vertical, spec);
    totalInserted += r.inserted;
    totalWithDate += r.withDate;
  }

  console.log(`\n=== TOTAL: ${totalInserted} new rows for ${vertical}, ${totalWithDate} with source_published_at`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
