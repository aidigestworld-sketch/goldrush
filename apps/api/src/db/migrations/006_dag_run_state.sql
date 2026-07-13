-- Adds the dag_run_state checkpoint table for the Phase 6 Orchestrator.
--
-- BullMQ is the execution layer (Redis-backed, ephemeral queues); this
-- table is the source of truth for DAG progress. A single physical
-- "orchestration" through the 12 live-agent stages for one hypothesis
-- is grouped by run_id (a fresh Postgres uuid — NOT the existing
-- pipeline_run.run_id, though the Orchestrator's implementation happens
-- to reuse pipeline_run.run_id as its run_id so agent_execution_log
-- and dag_run_state stay joinable on the same key).
--
-- One row per (run_id, step). The unique constraint on (run_id, step)
-- is the idempotency backbone: a job handler that finds a
-- status='succeeded' row for its (run_id, step) returns early without
-- re-invoking the underlying agent, so a re-enqueue or a BullMQ retry
-- against an already-succeeded step is a no-op.
--
-- candidate_id is nullable — populated once Composition (stage 8)
-- creates a candidate. Before stage 8, every step's row for a given
-- run has candidate_id=NULL because there's nothing to attach.
--
-- status enum values:
--   pending          — row created, job enqueued, not yet picked up
--   running          — worker acquired the job and is executing it
--   succeeded        — handler committed, no re-run needed
--   failed_permanent — BullMQ's attempts (3) with exponential backoff
--                      all exhausted; must be manually retried
--
-- attempt_count reflects the number of times a worker started this
-- step (running transitions). It stays consistent across job restarts
-- because handlers increment it BEFORE calling the underlying agent
-- (see live/orchestrator/handlers.ts).
--
-- Foreign keys are deliberately absent on run_id/candidate_id (loose
-- coupling): the checkpoint table is a durable execution log; it must
-- survive candidate deprecation and pipeline_run cascades without
-- constraint failures. The joinability is by column name, not FK.

BEGIN;

CREATE TABLE dag_run_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL,
  hypothesis_id    uuid,
  candidate_id     uuid,
  step             text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  attempt_count    integer NOT NULL DEFAULT 0,
  last_error       text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dag_run_state_step_check CHECK (step IN (
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
    'compression'
  )),
  CONSTRAINT dag_run_state_status_check CHECK (status IN (
    'pending',
    'running',
    'succeeded',
    'failed_permanent'
  )),

  -- Per the task spec: idempotency backbone. One row per DAG stage
  -- per orchestration. MVP scope processes one hypothesis per run and
  -- the DAG's fork/join happens on a single candidate — so (run_id,
  -- step) is unique. If a future revision fans out multiple candidates
  -- per run, this unique constraint expands to include candidate_id.
  CONSTRAINT dag_run_state_run_step_unique UNIQUE (run_id, step)
);

-- Common lookups: "give me every step's status for this run"
CREATE INDEX idx_dag_run_state_run_id ON dag_run_state (run_id);
CREATE INDEX idx_dag_run_state_hypothesis ON dag_run_state (hypothesis_id) WHERE hypothesis_id IS NOT NULL;
CREATE INDEX idx_dag_run_state_candidate ON dag_run_state (candidate_id) WHERE candidate_id IS NOT NULL;

COMMIT;
