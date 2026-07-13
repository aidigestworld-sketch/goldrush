-- Fixes the broken founder_evidence_target_field_check constraint.
--
-- Migration 011 created the constraint using chr() string concatenation
-- (e.g. chr(39)||chr(101)||... for 'expertise'), which caused PostgreSQL
-- to store the chr(39) apostrophe characters as PART OF the string value
-- rather than as SQL string delimiters. As a result only values like
-- "'expertise'" (with embedded apostrophes) passed the check, not the
-- intended plain values like "expertise".
--
-- This migration drops the malformed constraint and re-adds it with
-- proper SQL string literals.

BEGIN;

ALTER TABLE founder_evidence
  DROP CONSTRAINT founder_evidence_target_field_check;

ALTER TABLE founder_evidence
  ADD CONSTRAINT founder_evidence_target_field_check
    CHECK (target_field IN ('expertise', 'distribution_assets', 'capital_availability'));

COMMIT;
