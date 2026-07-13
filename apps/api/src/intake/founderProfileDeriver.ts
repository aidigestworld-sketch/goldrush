// Derives denormalized founder profile columns from founder_evidence rows.
//
// WHY DENORMALIZE AT ALL: FounderFit Agent reads founder.expertise[],
// founder.distribution_assets, and founder.capital_availability directly
// (no join, no aggregation at query time — hot path). Keeping the
// denormalized columns means FounderFit's read path is unchanged. The
// trade-off is that these columns now trail the evidence table by one
// write cycle; the intake flow accepts this because it re-derives
// immediately after every answer is recorded, so they stay in sync for
// all practical purposes.
//
// DERIVATION RULES (v1 — simple, no LLM):
//   expertise          → deduplicated list of extracted_values from all
//                        expertise-target evidence rows, ordered by
//                        creation time. Later entries are appended, not
//                        overwritten (founders can add to their expertise
//                        across multiple turns).
//   distributionAssets → same pattern as expertise.
//   capitalAvailability → single string: the extracted_value of the
//                        LATEST capital_availability evidence row.
//                        Capital is a point-in-time fact, not an
//                        accumulation — "raised $200K" supersedes
//                        "bootstrapped" if the founder updates.
//
// All functions are pure — take an array of evidence rows (already
// loaded from DB), return the derived value. No DB access here.

export interface EvidenceRow {
  id: string;
  targetField: string;   // snake_case as stored: "expertise", "distribution_assets", "capital_availability"
  extractedValue: string;
  rawAnswer: string;
  createdAt: Date;
}

export interface DerivedProfile {
  expertise: string[];
  distributionAssets: string[];
  capitalAvailability: string | null;
}

export function deriveProfileFromEvidence(rows: EvidenceRow[]): DerivedProfile {
  const expertiseRows = rows
    .filter((r) => r.targetField === "expertise")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const distributionRows = rows
    .filter((r) => r.targetField === "distribution_assets")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const capitalRows = rows
    .filter((r) => r.targetField === "capital_availability")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Deduplicate: use insertion-order Set to drop exact duplicates while
  // preserving the order answers were given. Case-sensitive — a founder
  // saying "Shopify development" twice adds it once.
  const expertise = [...new Set(expertiseRows.map((r) => r.extractedValue).filter((v) => v.trim().length > 0))];
  const distributionAssets = [...new Set(distributionRows.map((r) => r.extractedValue).filter((v) => v.trim().length > 0))];

  // Latest-wins for capital (single value)
  const capitalAvailability =
    capitalRows.length > 0 ? capitalRows[capitalRows.length - 1].extractedValue : null;

  return { expertise, distributionAssets, capitalAvailability };
}

// Derive only one field — used when re-deriving after a single new answer.
export function deriveFieldFromEvidence(
  rows: EvidenceRow[],
  field: "expertise" | "distribution_assets" | "capital_availability"
): string[] | string | null {
  const fieldRows = rows
    .filter((r) => r.targetField === field)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (field === "capital_availability") {
    return fieldRows.length > 0 ? fieldRows[fieldRows.length - 1].extractedValue : null;
  }
  return [...new Set(fieldRows.map((r) => r.extractedValue).filter((v) => v.trim().length > 0))];
}
