-- Adds pipeline_search_log — the durable audit trail that makes
-- AI_AGENTS.md §6's "log an explicit 'no further sources available'
-- result" invariant actually checkable after the fact. Before this
-- migration, Validation Collector's active-search step (wired via
-- pipeline/searchForHypothesisEvidence.ts) returned the log payload
-- to its caller for inspection but nothing persisted; a future
-- Orchestrator-side "did Validation actually search this hypothesis?"
-- audit had no row to query against.
--
-- Schema shape is copied verbatim from the proposal in
-- searchForHypothesisEvidence.ts's header — no changes from the shape
-- the code already constructs, just moving it from an in-memory
-- payload to a persisted row.
--
-- Design choices:
--   * hypothesis_id is nullable, NOT foreign-keyed to hypothesis(id).
--     Nullable: pre-hypothesis searches (Discovery/Expansion-side use,
--     if we later add one) legitimately have no hypothesis to attribute
--     the search to. No FK: matches node_source_refs's polymorphic
--     pattern (§4) — Validation's search is Hypothesis-scoped in the
--     current use, but the log itself is Data Pipeline audit, not part
--     of the graph. Keeping it unlinked avoids cascading deletes we
--     don't want if a Hypothesis is later archived.
--   * run_id IS FK — every search happens inside a pipeline_run and
--     that link needs to survive; if the run is retained, so is the
--     search log; if the run is somehow removed, the log rows go
--     with it (they're only meaningful in that run's context).
--   * connector column is text, not enum-constrained (yet). Reason:
--     we currently have one search-capable connector (tavily-search)
--     but there is no reason the invariant needs to force a CHECK
--     constraint at this stage — misspellings will be caught by
--     downstream reporting queries, not silently swallow bad data.
--     If/when a second connector lands, adding a CHECK is a one-line
--     follow-up migration.
BEGIN;

CREATE TABLE pipeline_search_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES pipeline_run(run_id),
  hypothesis_id uuid,
  connector     text NOT NULL,
  query_text    text NOT NULL,
  result_count  integer NOT NULL,
  executed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_search_log_run
  ON pipeline_search_log(run_id, hypothesis_id);

COMMIT;
