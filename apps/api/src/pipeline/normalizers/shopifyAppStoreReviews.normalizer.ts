// Parses a Shopify App Store reviews page (already converted to
// readable text/markdown — see connector comment for why raw HTML
// CSS-selector parsing was deliberately avoided) into one
// NormalizedEvidence per individual review.
//
// Each review becomes its own Evidence row — this matters for
// Confidence Agent's cluster-weighting (AI_AGENTS.md §5.2): 232
// reviews on one app page are 232 *independent* merchants, not one
// blob, and should end up as 232 distinct cluster_id assignments
// later (Reclustering), not one.
import type { NormalizedEvidence, SourceAuthorityTier } from "../types";

// "Show more" is a UI toggle Shopify shows for truncated reviews —
// present in the fixture this was built against, but not guaranteed
// to appear in every review's markup (short reviews may never need
// truncating). Made optional so the pattern doesn't silently drop
// short reviews once tested against real, varied HTML.
const REVIEW_BLOCK_PATTERN =
  /([A-Z][a-z]+ \d{1,2}, \d{4})\n\n([\s\S]+?)\n\n(?:Show more\n\n)?(.+)\n\n(.+)\n\n(.+) using the app/g;

const REVIEW_COUNT_PATTERN = /## Reviews \((\d+)\)/;

export interface ParsedReview {
  date: Date;
  bodyText: string;
  merchantName: string;
  country: string;
  durationUsingApp: string;
}

export function parseReviewCount(pageText: string): number | null {
  const match = pageText.match(REVIEW_COUNT_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}

export function parseReviews(pageText: string): ParsedReview[] {
  const reviews: ParsedReview[] = [];
  REVIEW_BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REVIEW_BLOCK_PATTERN.exec(pageText)) !== null) {
    const [, dateStr, bodyText, merchantName, country, durationUsingApp] = match;
    const parsedDate = new Date(dateStr);
    if (isNaN(parsedDate.getTime())) continue;
    reviews.push({
      date: parsedDate,
      bodyText: bodyText.trim(),
      merchantName: merchantName.trim(),
      country: country.trim(),
      durationUsingApp: durationUsingApp.trim(),
    });
  }
  return reviews;
}

export function normalizeShopifyAppStoreReviews(
  pageText: string,
  sourceUrl: string,
  fetchedAt: Date
): NormalizedEvidence[] {
  const reviews = parseReviews(pageText);
  const authorityTier: SourceAuthorityTier = "review_verified";

  return reviews.map((review) => ({
    sourceUrlOrIdentifier: sourceUrl,
    sourceType: "review_complaint",
    sourceAuthorityTier: authorityTier,
    extractionMethod: "html_parse",
    extractionConfidence: 0.9,
    extractedFact: `[${review.merchantName}, ${review.country}, ${review.durationUsingApp} using the app] ${review.bodyText}`,
    fetchedAt,
    // Per-review posted date is already parsed above via
    // REVIEW_BLOCK_PATTERN's first capture group. Persist it now
    // instead of discarding — this is the review's actual creation
    // date on the App Store, which is what freshness should measure
    // (not our scrape time). Migration 007.
    sourcePublishedAt: review.date,
    freshness: 1.0,
  }));
}
