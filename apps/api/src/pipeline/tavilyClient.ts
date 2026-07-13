// Thin HTTP wrapper around Tavily's /search endpoint.
//
// Deliberate mirror of NimLLMClient / AnthropicLLMClient's shape:
// small, explicit, Bearer-auth over global fetch, no SDK. This keeps
// the auth surface visible in one file and avoids taking on the
// tavily/tavily-node package's transitive tree just to POST one JSON
// body.
//
// Env pattern: process.env.TAVILY_API_KEY, loaded via `-r dotenv/config`
// on the caller (same as NVIDIA_API_KEY). Never hardcode a key here.
//
// Contract note: this client only knows how to talk HTTP to Tavily.
// It does NOT decide what to search for (that's the connector) and
// does NOT normalize results into Evidence shape (that's the
// normalizer). This is the single-responsibility split
// pipeline/types.ts's Connector interface was built around, extended
// here from "fetch one URL" to "fetch one search query."

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  // Tavily's default response returns `content` as cleaned/summarized
  // text (already extracted from the source page). raw_content is
  // available on request but disabled here — the whole point of using
  // Tavily over Google-CSE-plus-scraper is that it hands back clean
  // text and we don't have to re-parse HTML.
  score: number;
  published_date?: string;
}

export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number;
}

export interface TavilySearchOptions {
  // Tavily's search_depth: "basic" is the default and cheaper; "advanced"
  // is more thorough. MVP defaults to "advanced" because Validation
  // Collector's job is specifically to hunt for mechanism-specific
  // evidence — thoroughness matters more than the small extra spend.
  searchDepth?: "basic" | "advanced";
  maxResults?: number;
  // Optional domain include/exclude lists — useful later for scoping
  // (e.g. exclude social/aggregators, include vendor sites). Left off
  // by default so nothing is silently filtered on the first pass.
  includeDomains?: string[];
  excludeDomains?: string[];
}

export class TavilyClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.tavily.com"
  ) {}

  async search(query: string, options: TavilySearchOptions = {}): Promise<TavilySearchResponse> {
    const response = await fetch(`${this.baseUrl}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: options.searchDepth ?? "advanced",
        max_results: options.maxResults ?? 10,
        include_answer: false, // we don't want Tavily's own synthesis — search only, classification is Validation Collector's job
        include_raw_content: false, // clean text only; if we later need raw HTML we can flip this per-call
        include_domains: options.includeDomains,
        exclude_domains: options.excludeDomains,
      }),
    });
    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as TavilySearchResponse;
  }
}
