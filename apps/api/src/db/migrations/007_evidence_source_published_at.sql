-- Adds source_published_at (nullable timestamptz) to evidence.
--
-- Context: fetched_at, the only date column on evidence, is set at
-- ingestion time (new Date() inside every connector's fetch()). Any
-- freshness computation that uses fetched_at is therefore measuring
-- "when we scraped it," not "when the source was published." The
-- confidenceMode2.ts freshness formula (1/(1+age_days/90)) needs a
-- source-side timestamp to be meaningful.
--
-- This column is NULLABLE by design — per source_type, populate it
-- only where the raw source payload genuinely carries a publish date.
-- Null is the honest signal for "source did not expose a date," which
-- is preferable to inventing one from fetched_at (that would be an
-- indistinguishable-from-truth lie).
--
-- No index yet — the current corpus size (< 100 rows) and this column's
-- likely access pattern (batch read alongside per-candidate evidence
-- lookup, always joined via node_source_refs rather than filtered by
-- date range) don't warrant one. Revisit when evidence grows past
-- ~10k rows or a date-range filter becomes hot.

BEGIN;

ALTER TABLE evidence
  ADD COLUMN source_published_at timestamptz;

COMMIT;
