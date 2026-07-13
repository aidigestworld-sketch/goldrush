// Deterministic evidence-authority strength — the honest replacement for
// what hypothesis.supporting_evidence_strength used to hold (P3.1 audit
// finding: the column was previously fed the LLM's self-reported
// hypothesis confidence, which then corrupted Scoring's hypothesis
// sub-score by averaging one grounded number (validation_score) with one
// ungrounded one under a misleading name).
//
// Design constraints:
//  * Purely computable from existing DB fields — no LLM call.
//  * Genuinely distinct signal from validation_score. validation_score
//    is banded + gated by the Confidence Agent's semantic
//    answers_question judgment (confidenceSandbox.ts SCORE_BANDS); this
//    metric is arithmetic over authority tiers. A hypothesis with many
//    tangential high-authority citations can score high here and low on
//    validation_score, and vice versa — that divergence is the whole
//    point (see scoring.ts §hypothesis sub-score comment for why it's
//    the average of two).
//  * Uses AUTHORITY_TIER_RANK — the same tier map Confidence Mode 1
//    already reads for its highest-tier-per-polarity fact. One source
//    of truth for tier ordering across the codebase.
//
// Saturation constant = 8: 2× industry_report (10) or 2× competitor_self_stated
// (8) or 3× review_verified (9) or 4× forum_post (8) all reach 1.0 —
// "well-cited" for a hypothesis whose Bounded Rule already requires at
// least 2 distinct sources. Weakest possible (2× anonymous_comment) →
// 0.25, still non-zero because two independent low-authority sources
// beat one of them alone. Tunable if the distribution of real
// hypotheses shifts.
import { AUTHORITY_TIER_RANK } from "../sandbox/confidenceSandbox";

export const EVIDENCE_STRENGTH_SATURATION = 8;

export interface EvidenceStrengthItem {
  sourceUrlOrIdentifier: string;
  sourceAuthorityTier: string;
}

export function computeSupportingEvidenceStrength(items: EvidenceStrengthItem[]): number {
  if (items.length === 0) return 0;
  // Dedupe by source: one document cited twice must not double-count.
  // When a single source appears under multiple tiers (shouldn't happen
  // in practice, but defensive), keep its highest tier — mirroring
  // Confidence Mode 1's "highest tier per polarity" invariant.
  const highestTierBySource = new Map<string, string>();
  for (const it of items) {
    const existing = highestTierBySource.get(it.sourceUrlOrIdentifier);
    if (
      existing === undefined ||
      (AUTHORITY_TIER_RANK[it.sourceAuthorityTier] ?? 0) > (AUTHORITY_TIER_RANK[existing] ?? 0)
    ) {
      highestTierBySource.set(it.sourceUrlOrIdentifier, it.sourceAuthorityTier);
    }
  }
  let rawWeight = 0;
  for (const tier of highestTierBySource.values()) {
    // Unknown tier → 0 weight. Same defensive default confidenceSandbox
    // uses in highestAuthorityTier(). Real pipeline output is
    // constrained to the tier taxonomy, so this branch is mostly
    // defensive.
    rawWeight += AUTHORITY_TIER_RANK[tier] ?? 0;
  }
  return Math.min(rawWeight / EVIDENCE_STRENGTH_SATURATION, 1);
}
