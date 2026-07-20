-- 016_agent_execution_log_raw_output.sql
--
-- Adds raw_output TEXT (nullable) to agent_execution_log so post-hoc
-- triage can inspect the actual LLM response text on any run — the
-- prior schema stored only output_hash, which is useless for
-- diagnosing "why did Discovery / Expansion / etc. return zero markets
-- despite evidence existing" (the ba923046 case on 2026-07-15).
--
-- Storage: TEXT (unbounded) but the writer caps at 50KB per row so a
-- pathological jumbo completion (Discovery/Expansion can emit large
-- markets[] / problems[] arrays) doesn't bloat the table. The 50KB cap
-- is a heuristic — enough to capture normal-scale outputs whole,
-- enough of any truncated payload to reason about what happened.
--
-- Nullable because deterministic agents (Filtering, Composition,
-- Scoring, ConfidenceMode2, Compression) never call an LLM and have
-- no raw output to persist.

ALTER TABLE agent_execution_log
  ADD COLUMN IF NOT EXISTS raw_output TEXT;
