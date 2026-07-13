// Samples a percentage of normalized evidence for a secondary check —
// this is the Data Pipeline's own QA of its scraping/parsing
// (extraction_method: 'html_parse' / 'structured_api'), distinct from
// Validation/Confidence Agents' later evaluation of evidence *weight*
// (AI_AGENTS.md §5.2/§7). A parser silently mis-extracting a price or
// review count is a pipeline defect; that's caught here, not by an
// agent downstream that has no way to know what the page actually said.
//
// MVP behavior: flags a sampled fraction as needing manual review by
// setting verification_status = 'unverified' (the DB default) and
// recording which ones were selected; it does not auto-verify, since
// no automated secondary check exists yet. This is intentionally
// thin — a real secondary-parser or human-review queue is a Phase 2+
// enhancement, not required to unblock Phase 4 agent work.
export interface SampleDecision {
  index: number;
  shouldSample: boolean;
}

export function selectVerificationSample(
  totalCount: number,
  sampleRate: number // e.g. 0.1 for 10%
): SampleDecision[] {
  if (sampleRate < 0 || sampleRate > 1) {
    throw new Error(`sampleRate must be between 0 and 1, got ${sampleRate}`);
  }
  const decisions: SampleDecision[] = [];
  // Deterministic, even-spaced sampling rather than random — makes
  // test runs reproducible and avoids the awkwardness of "sometimes 0
  // sampled items" on small batches that pure random sampling risks.
  const interval = sampleRate > 0 ? Math.max(1, Math.round(1 / sampleRate)) : Infinity;
  for (let i = 0; i < totalCount; i++) {
    decisions.push({ index: i, shouldSample: i % interval === 0 });
  }
  return decisions;
}
