-- Makes agent_execution_log.run_id nullable so intake agents can log
-- without a pipeline_run row.
--
-- Intake turns are per-founder, not per-pipeline-run. Prior to this
-- migration, intakeExtractionAgent.ts passed founderId as runId which
-- violated the FK to pipeline_run.run_id. The fix: pass NULL for intake
-- agent log entries; the FK constraint on PostgreSQL silently allows NULL.

BEGIN;

ALTER TABLE agent_execution_log ALTER COLUMN run_id DROP NOT NULL;

COMMIT;
