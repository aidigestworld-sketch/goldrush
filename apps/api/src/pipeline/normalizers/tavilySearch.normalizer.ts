// Normalizes one Tavily search result (as packed by
// tavilySearch.connector.ts into a JSON RawDocument payload) into one
// NormalizedEvidence row.
//
// Design notes:
//   * source_authority_tier: Tavily doesn't tag results by
//     authority tier (industry_report vs forum_post vs vendor
//     material), so the safest MVP default is "forum_post" — the
//     LOWER of the credible tiers, treating fresh search results as
//     "unverified until further classified." This mirrors
//     verificationSampler.ts's stance that unverified means unverified.
//     Confidence Agent's tier-weighting will then apply the correct
//     discount.
//
//     ONE EXPLICIT EXCEPTION — the COMPETITOR_SELF_STATED_DOMAINS
//     allowlist below. Reasoning for why this narrow case is safe
//     when the general "infer tier from domain" heuristic remains
//     deferred: the general case fails on ambiguity ("*.gartner.com"
//     is sometimes an industry report, sometimes a marketing blog,
//     sometimes a customer story of another vendor), so a domain
//     heuristic would be wrong often enough to actively mislead
//     Confidence Agent's tier-weighting. The exact-domain-match case
//     below is different in kind, not degree: a page hosted on
//     `getrecharge.com`, `boldcommerce.com` (or `support.boldcommerce.com`),
//     or `loopwork.co` is definitionally the vendor speaking about
//     themselves — that IS what the `competitor_self_stated` tier
//     means (§3.1, source_authority_tier taxonomy). The mapping is
//     mechanical (host → vendor identity), the vendors are already
//     named in the target hypothesis (Recharge, Bold, Loop) so
//     there's zero ambiguity about who "self" is, and the set is
//     tiny and hand-maintained rather than heuristically inferred.
//     This is exactly the "narrow, explicit, per-competitor
//     allowlist" pattern — NOT the general heuristic that was
//     rejected. Adding a domain here is an intentional decision
//     tied to a specific competitor already in scope; do not
//     silently expand the list to broaden coverage.
//   * extraction_method: "structured_api" — this is a first-party API
//     response, not scraped HTML and not LLM extraction.
//   * extraction_confidence: pulled from Tavily's own `score` (0..1)
//     which is Tavily's relevance-to-query judgment, mapped straight
//     across. Different semantic from "confidence in the extracted
//     text being accurate" but the closest usable signal Tavily
//     exposes, and directionally right.
//   * freshness: derived from Tavily's optional published_date. If
//     present and recent (< 2 years), 1.0; if 2–5 years old, 0.5;
//     older, 0.2. If not present, null (unknown, not zero).
//   * extracted_fact: prepend the result title to Tavily's cleaned
//     content — the title is often the sharpest single-line
//     summary of what the source says, and losing it during
//     normalization is exactly the kind of "silently discarded
//     signal" migration 002 was written to fix.
import type { NormalizedEvidence, SourceAuthorityTier } from "../types";
import type { TavilyRawResultPayload } from "../connectors/tavilySearch.connector";

// Narrow allowlist: each entry is the registrable domain of a
// specific competitor named in the shopify_subscriptions vertical's
// active hypotheses. Matching is `host === domain || host.endsWith("." + domain)`
// so subdomains (e.g. support.boldcommerce.com, developer.rechargepayments.com)
// count as the same vendor's own material.
const COMPETITOR_SELF_STATED_DOMAINS: readonly string[] = [
  "getrecharge.com", // Recharge Payments — marketing/docs site
  "rechargepayments.com", // Recharge Payments — developer/API docs subdomain lives here (developer.rechargepayments.com); missed in the initial allowlist and caught during the first doubled-query Validation run when a Recharge API doc got tier-tagged forum_post
  "boldcommerce.com", // Bold Commerce (parent of Bold Subscriptions) — support.boldcommerce.com is the subs docs subdomain
  "loopwork.co", // Loop Subscriptions — company site + blog
];

function isCompetitorSelfStatedDomain(sourceUrl: string): boolean {
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return COMPETITOR_SELF_STATED_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

function freshnessScore(publishedDate: string | null, now: Date): number | null {
  if (!publishedDate) return null;
  const published = new Date(publishedDate);
  if (isNaN(published.getTime())) return null;
  const ageYears = (now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24 * 365);
  if (ageYears < 2) return 1.0;
  if (ageYears < 5) return 0.5;
  return 0.2;
}

// Parses Tavily's `published_date` (typically ISO 8601 or a
// permissive date string) into a Date. Returns null when the field is
// absent OR unparseable — feeding NaN dates downstream would poison
// any age calculation, and inventing a fallback (e.g. fetched_at)
// would silently equate ingestion time with publish time, exactly the
// bug migration 007 exists to fix. Kept separate from freshnessScore
// so the bucketized-vs-raw split is obvious at the call site.
function parseSourcePublishedAt(publishedDate: string | null): Date | null {
  if (!publishedDate) return null;
  const d = new Date(publishedDate);
  if (isNaN(d.getTime())) return null;
  return d;
}

export function normalizeTavilySearchResult(
  rawContent: string,
  sourceUrl: string,
  fetchedAt: Date
): NormalizedEvidence[] {
  const payload = JSON.parse(rawContent) as TavilyRawResultPayload;
  const authorityTier: SourceAuthorityTier = isCompetitorSelfStatedDomain(sourceUrl)
    ? "competitor_self_stated"
    : "forum_post";
  return [
    {
      sourceUrlOrIdentifier: sourceUrl,
      sourceType: "search_signal",
      sourceAuthorityTier: authorityTier,
      extractionMethod: "structured_api",
      extractionConfidence: payload.score,
      extractedFact: `[${payload.title}] ${payload.content}`,
      fetchedAt,
      // Raw source-side date preserved; the bucketized freshness score
      // stays alongside for any consumer that still depends on it.
      // Additive change, not a replacement — see migration 007 header.
      sourcePublishedAt: parseSourcePublishedAt(payload.publishedDate),
      freshness: freshnessScore(payload.publishedDate, fetchedAt),
    },
  ];
}
