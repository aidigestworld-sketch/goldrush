-- Adds the Confidence Mode 2 breakdown columns to opportunity_candidate.
--
-- Context: opportunity_candidate already carries `confidence_score`,
-- `coverage`, `agreement`, `freshness` from migration 001. Those
-- pre-existing generic columns were declared under the ORIGINAL Mode 2
-- design (round 1): coverage as a fraction, agreement as an unweighted
-- mean across all 5 composition slots, all three components blended
-- into confidence_score.
--
-- The 4-candidate audit bench (scripts/output/confidence_mode2_audit_data.json,
-- previewConfidenceMode2OnAudit.ts round 1) surfaced that round-1
-- design compressed every real candidate into a nearly-indistinguishable
-- 0.99+ range because contradicting evidence only ever lands on the
-- hypothesis slot under the current pipeline (Validation Collector is
-- the only writer that ever sets polarity='contradicting'; every other
-- slot takes the DB default 'supporting' from migration 003). Averaging
-- polarity across 5 slots attenuated the only real signal 5x.
--
-- Revised design (confidenceMode2.ts round 2):
--   * coverage becomes a BINARY GATE — all-5-slots-filled check per
--     the §8 invariant, not an averaged component. Different semantics
--     from the old `coverage real` column, so a new column with a
--     different name.
--   * agreement is computed EXCLUSIVELY from the hypothesis slot's
--     polarity split. Different formula from the old `agreement real`
--     column, so a new column with a different name.
--   * freshness stays a mean recency-decay but is NO LONGER blended
--     into confidence_score (its DECAY_CONSTANT_DAYS is still
--     provisional — see scripts/freshnessBench.ts). Kept as a
--     visible debug field so auditors can see what the curve produced.
--   * confidence_score (existing column) now stores the aggregate
--     (in this revision: == confidence_agreement).
--   * incomplete_composition is a new short-circuit flag surfaced
--     to Compression so it can distinguish "not scored yet" from
--     "scored but Composition gap-flagged."
--
-- Legacy columns (`coverage`, `agreement`, `freshness`) are LEFT IN
-- PLACE, NOT DROPPED, NOT WRITTEN TO. They currently hold NULL for
-- every existing candidate (round 1 never persisted anywhere) and no
-- reader references them yet. A follow-up cleanup migration can drop
-- them after this revision has run in production long enough to
-- confirm no external consumer picked them up in the interim. Same
-- principle as everywhere else in this project — never destroy in
-- the same migration that supersedes; leave a reversible interval.
--
-- Column semantics:
--   confidence_coverage_gate boolean nullable
--     NULL  = Mode 2 has not yet run for this candidate
--     TRUE  = all 5 composition slots resolved (§8 invariant held);
--             agreement/freshness/confidence_score are computed
--     FALSE = at least one slot was is_null; agreement/freshness/
--             confidence_score are NULL (short-circuit path)
--   incomplete_composition boolean nullable
--     Convenience mirror of `confidence_coverage_gate = FALSE`.
--     Kept separate so a Compression-side reader doesn't have to
--     encode the "false != null" quirk of Postgres boolean columns
--     to detect the short-circuit case. NULL = not yet run.
--   confidence_agreement real nullable
--     hypothesis-slot distinctSupporting / (distinctSupporting +
--     distinctContradicting). NULL when the gate failed OR the
--     hypothesis slot has zero cited evidence.
--   confidence_freshness real nullable
--     Mean of 1/(1 + age_days / DECAY_CONSTANT_DAYS) across the
--     candidate's linked evidence. NOT blended into confidence_score
--     in this revision — surfaced for visibility only. NULL when
--     candidate has zero linked evidence or gate failed.
--
-- Concurrency safety (AGENT_EXECUTION_DAG.md §5):
--   These columns are exclusively written by Confidence Mode 2
--   (stage 10a). FounderFit (stage 10b) writes founder_fit_score and
--   founder_fit_rationale. The two branches touch DISJOINT column
--   sets on the same candidate row and both use targeted
--   `UPDATE ... SET <owned columns only>` statements — Postgres'
--   SET clause is inherently column-scoped, so the concurrent-write
--   invariant is enforced at the query-construction level, exactly
--   as §5 requires.
BEGIN;

ALTER TABLE opportunity_candidate
  ADD COLUMN confidence_coverage_gate boolean,
  ADD COLUMN incomplete_composition   boolean,
  ADD COLUMN confidence_agreement     real,
  ADD COLUMN confidence_freshness     real;

-- No CHECK constraint on the boolean columns (Postgres already
-- enforces boolean-or-null typing). No CHECK on confidence_agreement
-- / confidence_freshness ranges either — the pure function guarantees
-- [0, 1] on write, and clamping at the SQL layer would only ever
-- catch a bug in that guarantee, at which point failing the write
-- entirely is more useful than a silent CHECK-triggered constraint
-- error mid-transaction. Same discipline as validation_score on
-- hypothesis (§7): trust the writer's contract, don't double-clamp.

COMMIT;
