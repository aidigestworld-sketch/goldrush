// Tavily search connector — the first live "search-capable" connector
// in Data Pipeline. Unblocks the invariant Validation Collector's
// contract (AI_AGENTS.md §6) has always required but couldn't satisfy
// without an external search backend: "MUST actively query Data
// Pipeline for disconfirming evidence per hypothesis, or log an
// explicit 'no further sources available' result."
//
// Contract fits pipeline/types.ts's Connector interface — `target` here
// is the SEARCH QUERY (a string), not a URL/slug like the Shopify
// connectors. One fetch() = one Tavily API call = one query, fans out
// to N RawDocuments (one per search result, up to Tavily's max_results).
//
// Deliberate scope split from the existing scraping connectors:
//   * ShopifyAppStoreReviewsConnector: fetches ONE URL, connector
//     returns ONE RawDocument (the page), normalizer produces N
//     Evidence rows (one per review found on the page).
//   * This connector: fetches ONE QUERY, connector returns N
//     RawDocuments (one per search result), normalizer produces one
//     Evidence per RawDocument (1:1 with results).
// The connector interface accommodates both fan-out patterns already.
//
// contentType is "json" here so ingest.ts's htmlToReadableText step
// is bypassed — Tavily's `content` field is already cleaned text.
import type { Connector, RawDocument, SourceType } from "../types";
import type { TavilyClient, TavilySearchOptions, TavilySearchResult } from "../tavilyClient";

export interface TavilyRawResultPayload {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate: string | null;
}

export class TavilySearchConnector implements Connector {
  readonly name = "tavily-search";
  // source_type is "search_signal" — the Evidence table's enum in
  // pipeline/types.ts already reserves this exact tier for search-
  // engine-derived material, distinct from marketplace/review/etc.
  readonly sourceType: SourceType = "search_signal";

  constructor(
    private readonly client: TavilyClient,
    private readonly options: TavilySearchOptions = {}
  ) {}

  async fetch(target: string): Promise<RawDocument[]> {
    const response = await this.client.search(target, this.options);
    const fetchedAt = new Date();

    return response.results.map((r: TavilySearchResult) => {
      const payload: TavilyRawResultPayload = {
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        publishedDate: r.published_date ?? null,
      };
      return {
        sourceUrlOrIdentifier: r.url,
        sourceType: this.sourceType,
        fetchedAt,
        rawContent: JSON.stringify(payload),
        contentType: "json" as const,
      };
    });
  }
}
