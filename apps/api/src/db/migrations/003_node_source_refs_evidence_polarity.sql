-- Adds evidence_polarity to node_source_refs so the supporting-vs-
-- contradicting distinction Validation Collector already MAKES
-- internally (validationSandbox.ts classifies every candidate as
-- 'supports' | 'contradicts' | 'inconclusive') actually SURVIVES the
-- write. Before this migration, both classifications wrote to the same
-- flat join row and the polarity signal was silently discarded on
-- commit — same class of bug as migration 002 (attribution flag lost
-- pre-persist), caught the same way (found during Confidence Agent's
-- first live run: distinct_contradicting_source_count reads 0
-- regardless of input because there is no way to reconstruct polarity
-- from the DB).
--
-- Deliberate scope decision (matches confidenceAgent.ts's honest-
-- limitation header): this column, NOT graph-level supports/contradicts
-- edges (GRAPH_SCHEMA.md §3), is where polarity lives for MVP. A
-- future migration can add those edges if edge-native reasoning
-- becomes valuable; for now, one column on an already-existing join
-- table is the smaller, reversible change.
--
-- NOT NULL DEFAULT 'supporting' is deliberate:
--   * Every existing row backfills to 'supporting' at ALTER TABLE time
--     — semantically correct for the current graph: all 40 existing
--     node_source_refs rows across every node_type reflect
--     evidence-that-establishes-the-node (never contradictions of it),
--     including the 4 refs on hypothesis 01c1110d whose polarity was
--     verified against Validation Collector's last run report
--     (2 supporting from Validation, 2 supporting from Hypothesis
--     Agent's manual seed, 0 contradicting).
--   * Hypothesis Agent's write path is deliberately NOT being updated
--     in this migration (its citations are always evidence_for by its
--     own contract, AI_AGENTS.md §5) — the DEFAULT lets that write
--     path keep working without code changes and get the correct
--     polarity value implicitly.
BEGIN;

ALTER TABLE node_source_refs
  ADD COLUMN evidence_polarity text NOT NULL DEFAULT 'supporting';

ALTER TABLE node_source_refs
  ADD CONSTRAINT chk_node_source_refs_evidence_polarity
    CHECK (evidence_polarity IN ('supporting','contradicting'));

COMMIT;
