-- Adds pipeline_run_id (nullable UUID) to the 6 graph node tables.
--
-- Rationale (Task E design decision): the current schema was designed
-- as a shared global graph; nodes are not tied to a run. That means
-- runFilteringAgent — which reads active Market/Audience/Problem rows
-- and deprecates those below a confidence threshold — deprecates
-- rows from other runs as collateral damage. Empirically demonstrated
-- earlier when the generalization probe's Filtering deprecated
-- pre-existing Shopify rows.
--
-- Fix: every write path populates pipeline_run_id from the run
-- context; every relevant read (Filtering especially) filters by it.
-- Duplicate node rows across runs are ACCEPTED — Compression's
-- promoted_from_candidate_id uniqueness already prevents duplicate
-- Opportunity output, and building a node-dedup/membership-table
-- mechanism is explicitly deferred as a future optimization.
--
-- Nullable + backfilled: existing rows are backfilled to run
-- 28e862eb-7d47-4c8c-aa7d-66510bbe0166 (the pipeline_run that produced
-- the first real promoted Opportunity c587360e). Any node created from
-- here on MUST populate pipeline_run_id — but until Task E's write-path
-- changes ship in the same PR, a null value has to remain permitted
-- to avoid a NOT NULL failure on any concurrent write.
--
-- No FK to pipeline_run — deliberate loose coupling. If a run row is
-- ever hard-deleted, nodes it created should remain queryable (audit
-- trail), same reasoning that keeps dag_run_state FK-less.
--
-- No index — the node tables are small (single-digit MB total) and
-- the primary access pattern is by id or by status='active'; filtering
-- adds one more predicate but doesn't merit a compound index yet.
-- Revisit when node counts pass the 100k mark or Filtering shows up
-- in explain plans.

BEGIN;

ALTER TABLE market            ADD COLUMN pipeline_run_id uuid;
ALTER TABLE audience          ADD COLUMN pipeline_run_id uuid;
ALTER TABLE problem           ADD COLUMN pipeline_run_id uuid;
ALTER TABLE existing_solution ADD COLUMN pipeline_run_id uuid;
ALTER TABLE hypothesis        ADD COLUMN pipeline_run_id uuid;
ALTER TABLE business_model    ADD COLUMN pipeline_run_id uuid;

-- Backfill: the sole complete DAG run that produced the first
-- promoted Opportunity. Every pre-existing node came from this run.
UPDATE market            SET pipeline_run_id = '28e862eb-7d47-4c8c-aa7d-66510bbe0166' WHERE pipeline_run_id IS NULL;
UPDATE audience          SET pipeline_run_id = '28e862eb-7d47-4c8c-aa7d-66510bbe0166' WHERE pipeline_run_id IS NULL;
UPDATE problem           SET pipeline_run_id = '28e862eb-7d47-4c8c-aa7d-66510bbe0166' WHERE pipeline_run_id IS NULL;
UPDATE existing_solution SET pipeline_run_id = '28e862eb-7d47-4c8c-aa7d-66510bbe0166' WHERE pipeline_run_id IS NULL;
UPDATE hypothesis        SET pipeline_run_id = '28e862eb-7d47-4c8c-aa7d-66510bbe0166' WHERE pipeline_run_id IS NULL;
UPDATE business_model    SET pipeline_run_id = '28e862eb-7d47-4c8c-aa7d-66510bbe0166' WHERE pipeline_run_id IS NULL;

COMMIT;
