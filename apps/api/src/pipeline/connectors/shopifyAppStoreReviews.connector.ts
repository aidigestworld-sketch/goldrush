// Fetches a Shopify App Store reviews page for a given app slug.
//
// IMPORTANT — this connector's live HTTP fetch has NOT been tested
// from the environment this was written in: that sandbox's network
// egress is restricted to package registries (npm/pypi/github), not
// general web domains like apps.shopify.com. The parsing logic it
// feeds into (shopifyAppStoreReviews.normalizer.ts) WAS tested, against
// a real fixture pulled from the live page. Verify this connector's
// actual fetch() call against the real network yourself before
// trusting it in Phase 4 — that's a different risk than the parsing
// logic being wrong.
//
// Uses Node's built-in fetch (Node 22+, no extra HTTP client needed).
import type { Connector, RawDocument } from "../types";

export class ShopifyAppStoreReviewsConnector implements Connector {
  readonly name = "shopify-app-store-reviews";
  readonly sourceType = "review_complaint" as const;

  // `target` is the app's Shopify App Store slug, e.g. "skio", "recharge".
  async fetch(target: string): Promise<RawDocument[]> {
    const url = `https://apps.shopify.com/${target}/reviews`;
    const response = await fetch(url, {
      headers: {
        // A real UA string matters here — some storefronts serve a
        // stripped-down page to obvious bot/default fetch UAs.
        "User-Agent":
          "Mozilla/5.0 (compatible; OpportunityEngineDataPipeline/0.1; +https://goldrush.capital)",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const rawContent = await response.text();
    return [
      {
        sourceUrlOrIdentifier: url,
        sourceType: this.sourceType,
        fetchedAt: new Date(),
        rawContent,
        contentType: "html",
      },
    ];
  }
}
