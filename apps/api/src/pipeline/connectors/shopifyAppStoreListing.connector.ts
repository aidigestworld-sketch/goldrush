// Fetches a Shopify App Store app listing page (pricing + positioning
// copy) — this is "competitor material" (VERTICAL_BASELINE.md §3
// item, GRAPH_SCHEMA.md source_type='competitor_material').
//
// Same untested-live-fetch caveat as the reviews connector: parsing
// logic below has NOT been verified against a real fetched listing
// page from this sandbox (no network access to apps.shopify.com
// here). Structure it against a real fixture the same way the
// reviews normalizer was, before trusting it in Phase 4.
import type { Connector, RawDocument } from "../types";

export class ShopifyAppStoreListingConnector implements Connector {
  readonly name = "shopify-app-store-listing";
  readonly sourceType = "competitor_material" as const;

  async fetch(target: string): Promise<RawDocument[]> {
    const url = `https://apps.shopify.com/${target}`;
    const response = await fetch(url, {
      headers: {
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
