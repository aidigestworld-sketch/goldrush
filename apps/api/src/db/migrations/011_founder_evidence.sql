-- Adds founder_evidence table: one row per interview answer.
--
-- Rationale: symmetric with the main DAG's Evidence → Hypothesis path.
-- Each interview answer is an atomic unit of self-reported signal: the
-- question asked, the verbatim response, and the normalized extracted
-- value derived from it. FounderFit can now cite a specific answer row
-- (founder_evidence_id) rather than just claiming a match against an
-- aggregated string field — same discipline as node_source_refs
-- grounding hypothesis claims to real evidence sources.
--
-- APPEND-ONLY: no UPDATE or DELETE in normal flow. A correction /
-- retraction is a NEW row, preserving the full interview trail.
-- If a founder changes an answer, the intake engine re-derives the
-- denormalized founder.expertise/distribution_assets/capital_availability
-- columns from the current set of evidence rows (the derivation is
-- idempotent over the full trail, not delta-applied).
--
-- target_field uses the same snake_case enum values as FounderFit's
-- source_field so the two sides can be compared directly without
-- a mapping step.

BEGIN;

CREATE TABLE founder_evidence (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id        uuid        NOT NULL REFERENCES founder(id) ON DELETE CASCADE,
  target_field      text        NOT NULL,
  question_asked    text        NOT NULL,
  raw_answer        text        NOT NULL,
  extracted_value   text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT founder_evidence_target_field_check
    CHECK (target_field IN ('expertise', 'distribution_assets', 'capital_availability'))
);

-- Index for the primary hot-path query: load all evidence for a founder
-- ordered by creation time (used by the deriver and FounderFit agent).
CREATE INDEX idx_founder_evidence_founder_id
  ON founder_evidence(founder_id, created_at);

COMMIT;
