// Shared types for the Data Pipeline — deliberately mirrors the
// Evidence table shape (DATABASE_SCHEMA.md §3.1) so normalization has
// one clear target, not an ad-hoc intermediate format.

export type SourceType =
  | "search_signal"
  | "marketplace"
  | "review_complaint"
  | "competitor_material"
  | "industry_report"
  | "financial_signal";

export type SourceAuthorityTier =
  | "industry_report"
  | "competitor_self_stated"
  | "review_verified"
  | "forum_post"
  | "anonymous_comment";

export type ExtractionMethod = "structured_api" | "html_parse" | "llm_extraction";

// What a Connector hands back — raw, unparsed-into-fields, before
// the Normalizer turns it into something matching the Evidence table.
export interface RawDocument {
  sourceUrlOrIdentifier: string;
  sourceType: SourceType;
  fetchedAt: Date;
  rawContent: string; // HTML, JSON string, whatever the connector fetched
  contentType: "html" | "json";
}

// Output of normalization — one-to-one with evidence table columns
// (DATABASE_SCHEMA.md §3.1), minus id/status/cluster fields the
// repository/DB assign.
export interface NormalizedEvidence {
  sourceUrlOrIdentifier: string;
  sourceType: SourceType;
  sourceAuthorityTier: SourceAuthorityTier;
  extractionMethod: ExtractionMethod;
  extractionConfidence: number | null;
  extractedFact: string;
  fetchedAt: Date;
  // Source-side publish/creation date. NULL when the raw source
  // payload does not carry a parseable date — inventing one from
  // fetched_at would be indistinguishable-from-truth misinformation,
  // so null is the honest signal. See migration 007.
  sourcePublishedAt: Date | null;
  freshness: number | null;
}

// Every source-specific scraper implements this. Kept deliberately
// narrow — a Connector's only job is "go get the raw thing," never
// parsing or scoring. That's the Normalizer's job (single
// responsibility, same reasoning as the agent roster in AI_AGENTS.md).
export interface Connector {
  readonly name: string;
  readonly sourceType: SourceType;
  fetch(target: string): Promise<RawDocument[]>;
}
