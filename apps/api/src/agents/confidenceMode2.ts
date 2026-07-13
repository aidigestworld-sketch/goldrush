// Confidence Agent, Mode 2 — deterministic (AI_AGENTS.md §7 Mode 2,
// AGENT_EXECUTION_DAG.md §2 stage 10a). Runs on an
// opportunity_candidate AFTER Composition + Scoring have committed,
// consuming only the candidate's 5 composition rows and the evidence
// cited on each of those rows via node_source_refs. Same "pure
// function only" pattern as filtering.ts / composition.ts /
// scoring.ts / compression.ts — no DB access, no LLM call, no
// side-effects; the live wrapper (not yet written) will do the read
// and the targeted-column UPDATE (§5's disjoint-column concurrency
// requirement with FounderFit) around this function.
//
// REVISED FORMULA (round 2, after preview audit):
// The first pass averaged agreement across all 5 slots. The 4-candidate
// preview surfaced a real problem: contradicting evidence only ever
// appears on the hypothesis slot (Validation Collector is the only
// write path that sets polarity='contradicting'; every other slot
// takes the DB default 'supporting'). Averaging across 5 slots
// therefore attenuates the only real polarity signal 5x, and the
// preview showed all 4 candidates clustering at 0.99+, no separation.
// Revised design:
//   - coverage becomes a BINARY GATE (§8 invariant check, not an
//     averaged component)
//   - agreement is computed EXCLUSIVELY from the hypothesis slot's
//     polarity split (the only slot where contradicting evidence
//     actually lands under the current pipeline)
//   - freshness is still computed and returned as its own field for
//     visibility, but NOT blended into confidence_score (see TODO —
//     the corpus has no age spread to validate DECAY_CONSTANT_DAYS)
//   - confidence_score = agreement, once the gate passes
// The four non-hypothesis slots keep supporting/contradicting counts
// in the debug output for future audits, but do not contribute to
// the aggregate.
export const COMPOSITION_ROLES = [
  "market",
  "audience",
  "problem",
  "hypothesis",
  "business_model",
] as const;
export type CompositionRole = (typeof COMPOSITION_ROLES)[number];

export interface SourceRef {
  evidenceId: string;
  evidencePolarity: "supporting" | "contradicting";
}

export interface CompositionSlot {
  role: CompositionRole;
  isNull: boolean; // true when Composition failed to resolve this slot
  sourceRefs: SourceRef[];
}

export interface EvidenceItem {
  evidenceId: string;
  // Ingestion timestamp (when Data Pipeline first wrote the row). Kept
  // for the recency FALLBACK only — real source-side recency lives on
  // sourcePublishedAt when that's populated. See migration 007.
  fetchedAt: Date;
  // Source-side publish/creation date (from the raw source itself, not
  // the ingest wall-clock). Populated for ~25% of the corpus at time
  // of writing (all rows in search_signal that carry a parseable
  // date; 0% for competitor_material / review_complaint / financial_signal,
  // which have no such field). NULL means "not available" — inventing
  // a date from fetchedAt would be indistinguishable-from-truth
  // misinformation. See migration 007 and pipeline/types.ts.
  sourcePublishedAt: Date | null;
}

export interface ConfidenceMode2Input {
  slots: CompositionSlot[]; // one entry per COMPOSITION_ROLES
  evidence: EvidenceItem[]; // deduped union of all evidence_ids cited by any slot
  now?: Date; // injectable for tests; defaults to new Date()
}

// Per-slot inventory. Kept in the output for debugging/audit only;
// only the hypothesis slot's counts feed the aggregate now.
export interface SlotEvidenceCounts {
  role: CompositionRole;
  distinctSupportingCount: number;
  distinctContradictingCount: number;
}

export interface ConfidenceMode2Output {
  // Binary composition-completeness signal. 1 = all 5 slots filled;
  // 0 = at least one slot was is_null (§8 invariant broken, so the
  // rest of the computation short-circuits).
  coverageGate: 0 | 1;
  // Convenience mirror of `coverageGate === 0` for the caller — the
  // task spec explicitly asked for this flag on the result.
  incompleteComposition: boolean;
  // Hypothesis-slot-only agreement: distinctSupporting / (distinctSupporting + distinctContradicting).
  // null when the gate fails OR the hypothesis slot has zero cited evidence.
  agreement: number | null;
  // Mean recency-decay across the candidate's linked evidence.
  // NOT FINALIZED — see DECAY_CONSTANT_DAYS comment. Returned for
  // visibility but NOT blended into confidence_score in this revision.
  freshness: number | null;
  // Equal to `agreement` once the gate passes; null otherwise.
  // TODO: reintroduce freshness with a confirmed weight once
  // DECAY_CONSTANT_DAYS is validated against temporally-diverse
  // evidence (see scripts/freshnessBench.ts KNOWN GAP note).
  confidenceScore: number | null;
  // Per-slot supporting/contradicting inventory. Debug-only in this
  // revision; the four non-hypothesis slots do NOT contribute to
  // aggregate agreement anymore.
  slotEvidenceCounts: SlotEvidenceCounts[];
  // Per-evidence recency provenance — which timestamp actually drove
  // the freshness contribution for each row. Present alongside the
  // aggregate `freshness` so auditors can see which candidates'
  // scores are grounded in real source dates ("source_published_at")
  // versus the ingest-time fallback ("fetched_at_fallback"). Same
  // observability pattern as the JSON-repair fix's repaired/retried
  // fields. Empty array when input.evidence is empty.
  freshnessSources: FreshnessSource[];
  // Aggregate counts, convenient for run-level reporting.
  freshnessFallbackCount: number; // evidence rows that fell back to fetchedAt
  freshnessSourcePublishedCount: number; // evidence rows that used sourcePublishedAt
}

export interface FreshnessSource {
  evidenceId: string;
  usedTimestamp: "source_published_at" | "fetched_at_fallback";
  ageDays: number; // >=0; matches the age fed into the decay formula
}

// PROVISIONAL, unchanged from round 1: half-life-style decay in days.
//   freshness_per_evidence = 1 / (1 + age_days / DECAY_CONSTANT_DAYS)
// TODO: validate against evidence with a wider fetched_at spread (the
// current corpus is all < 2 days old — see scripts/freshnessBench.ts).
// Until that validation lands, freshness is computed and surfaced
// for auditors but NOT blended into confidence_score.
export const DECAY_CONSTANT_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeConfidenceMode2(input: ConfidenceMode2Input): ConfidenceMode2Output {
  const now = input.now ?? new Date();

  // Slot inventory happens up-front regardless of gate outcome — it's
  // free (a linear pass over the input) and the debug consumer wants
  // it even for the incomplete-composition case, so they can see
  // which slot was empty.
  const slotEvidenceCounts: SlotEvidenceCounts[] = input.slots.map((slot) => {
    const supporting = new Set<string>();
    const contradicting = new Set<string>();
    for (const ref of slot.sourceRefs) {
      if (ref.evidencePolarity === "supporting") supporting.add(ref.evidenceId);
      else if (ref.evidencePolarity === "contradicting") contradicting.add(ref.evidenceId);
    }
    return {
      role: slot.role,
      distinctSupportingCount: supporting.size,
      distinctContradictingCount: contradicting.size,
    };
  });

  // ---- coverage: binary gate ----
  const totalSlots = COMPOSITION_ROLES.length;
  const filledSlots = input.slots.filter((s) => !s.isNull).length;
  const coverageGate: 0 | 1 = filledSlots === totalSlots ? 1 : 0;

  if (coverageGate === 0) {
    // §8 invariant broken — refuse to score. Freshness is short-
    // circuited too even though it's technically independent of
    // composition completeness; if a candidate reached Mode 2 with
    // holes, the whole result should be treated as "not scored,"
    // not "partly scored."
    return {
      coverageGate,
      incompleteComposition: true,
      agreement: null,
      freshness: null,
      confidenceScore: null,
      slotEvidenceCounts,
      freshnessSources: [],
      freshnessFallbackCount: 0,
      freshnessSourcePublishedCount: 0,
    };
  }

  // ---- agreement: hypothesis slot ONLY ----
  const hypothesisCounts = slotEvidenceCounts.find((s) => s.role === "hypothesis");
  // Should never be undefined given coverageGate==1 (slotEvidenceCounts is
  // built from input.slots and gate passing means all 5 roles are present).
  // Defensive fallback keeps the type checker happy without a non-null assertion.
  const hypSupporting = hypothesisCounts?.distinctSupportingCount ?? 0;
  const hypContradicting = hypothesisCounts?.distinctContradictingCount ?? 0;
  const hypTotal = hypSupporting + hypContradicting;
  const agreement = hypTotal === 0 ? null : hypSupporting / hypTotal;

  // ---- freshness: still computed, still returned, NOT blended ----
  // Prefer source-side publish date (migration 007's whole reason for
  // existing) — fetchedAt is ingest-wall-clock, not "how recent is
  // the underlying claim." Fallback to fetchedAt when sourcePublishedAt
  // is null, and record per-row which timestamp was actually used so
  // auditors can distinguish real-source-date recency from ingest-time
  // fallback. Same observability pattern as the JSON-repair fix's
  // repaired/retried fields — visible, not silently coalesced.
  const freshnessSources: FreshnessSource[] = input.evidence.map((e) => {
    const usedSource = e.sourcePublishedAt !== null;
    const timestamp = usedSource ? (e.sourcePublishedAt as Date) : e.fetchedAt;
    const ageDays = Math.max(0, (now.getTime() - timestamp.getTime()) / MS_PER_DAY);
    return {
      evidenceId: e.evidenceId,
      usedTimestamp: usedSource ? "source_published_at" : "fetched_at_fallback",
      ageDays,
    };
  });
  const perEvidenceFreshness = freshnessSources.map(
    (s) => 1 / (1 + s.ageDays / DECAY_CONSTANT_DAYS)
  );
  const freshness =
    perEvidenceFreshness.length === 0
      ? null
      : perEvidenceFreshness.reduce((sum, v) => sum + v, 0) / perEvidenceFreshness.length;
  const freshnessFallbackCount = freshnessSources.filter((s) => s.usedTimestamp === "fetched_at_fallback").length;
  const freshnessSourcePublishedCount = freshnessSources.length - freshnessFallbackCount;

  // ---- confidence_score: agreement only in this revision ----
  const confidenceScore = agreement;

  return {
    coverageGate,
    incompleteComposition: false,
    agreement,
    freshness,
    confidenceScore,
    slotEvidenceCounts,
    freshnessSources,
    freshnessFallbackCount,
    freshnessSourcePublishedCount,
  };
}
