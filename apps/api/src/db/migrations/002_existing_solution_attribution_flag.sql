-- Adds the field CompetitiveAnalysis Agent's sandbox already computes
-- (positioning_summary_is_competitor_stated) but which the repository/
-- migration never had anywhere to persist it — so the attribution
-- distinction ("Bold's own words" vs "an analyst's opinion about
-- Bold") was being silently discarded before ever reaching Postgres,
-- even on a run where the model got the distinction exactly right.
-- Found during CompetitiveAnalysis's first live NIM run.
--
-- Nullable: existing rows (and any future write path that doesn't set
-- it) default to NULL, meaning "attribution unknown" — NOT the same
-- as `false`. Only an agent that actually checked should assert true
-- or false; a repository/agent that never considered the question
-- should not silently imply "not competitor-stated" by defaulting to
-- false.
BEGIN;

ALTER TABLE existing_solution
  ADD COLUMN positioning_summary_is_competitor_stated boolean;

COMMIT;
