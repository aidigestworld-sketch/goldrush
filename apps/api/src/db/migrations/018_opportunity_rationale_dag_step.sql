-- Adds "opportunity_rationale" to the dag_run_state.step CHECK constraint.
--
-- Wires the previously-orphaned OpportunityRationale agent into the
-- orchestrator. It runs AFTER Compression as a post-terminal polish
-- step: Compression creates the Opportunity row with empty
-- rationale_bullets / risk_summary arrays (compressionAgent.ts header,
-- "rationale_bullets/risk_summary are inserted as empty arrays here"),
-- and OpportunityRationale fills them in a SEPARATE transaction so the
-- promotion path isn't held under LLM latency.
--
-- Not part of LINEAR_ORDER or the fork/join topology — enqueued by
-- sequencing.advance() when compression succeeds. deriveOverallStatus
-- keeps "completed" tied to compression (unchanged UX) and excludes
-- this step from the pending/running check so a still-running or
-- failed rationale doesn't flip the run back to in_progress.

BEGIN;

ALTER TABLE dag_run_state DROP CONSTRAINT dag_run_state_step_check;

ALTER TABLE dag_run_state ADD CONSTRAINT dag_run_state_step_check CHECK (step IN (
  'discovery',
  'expansion',
  'filtering',
  'competitive_analysis',
  'hypothesis',
  'validation',
  'confidence_mode1',
  'composition',
  'scoring',
  'confidence_mode2',
  'founder_fit',
  'compression',
  'opportunity_rationale'
));

COMMIT;
