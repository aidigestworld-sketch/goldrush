-- =============================================================================
-- apply_all_pending_migrations.sql  (generated 2026-07-23)
--
-- One-shot concatenation of every migration in src/db/migrations/ (001..020).
-- Intended for running the full apps/api app-DB schema against a genuinely
-- empty `public` schema on Supabase Postgres. Do not commit updates to this
-- file — regenerate from migrations/ if needed.
--
-- Usage (Supabase SQL Editor):
--   1. Open Supabase Dashboard → SQL Editor → new query.
--   2. Paste this entire file.
--   3. Click Run. Watch the "Messages" panel for the RAISE NOTICE breadcrumbs
--      ("Applying <file>") — one per migration in order.
--   4. If any migration fails, its own BEGIN/COMMIT rolls back — earlier
--      migrations are already committed and safe. Fix the failing file, then
--      re-run only the remaining files (either individually or by editing
--      this script to remove already-applied ones).
--
-- Note on \echo: Supabase SQL Editor is a raw Postgres connection and does
-- NOT support psql client meta-commands (backslash commands). This script
-- uses `DO $$ BEGIN RAISE NOTICE 'msg'; END $$;` instead — same effect
-- (breadcrumb in the notices panel), works in both SQL Editor and psql.
--
-- Safety review recap (see chat for full audit):
--   * 0 DROP TABLE / DROP INDEX / DROP COLUMN / TRUNCATE / DELETE FROM
--   * 0 references to `auth.` schema (auth_user_id in 012 has no FK)
--   * 3 DROP CONSTRAINT calls, each on a constraint added earlier in this
--     same sequence — safe against empty schema
--   * Every migration wraps its statements in a top-level BEGIN..COMMIT,
--     so per-file atomicity is preserved
-- =============================================================================

DO $$ BEGIN RAISE NOTICE '===== Starting app-DB migration apply ====='; END $$;


-- -----------------------------------------------------------------------------
-- 001_initial_schema.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 001_initial_schema.sql'; END $mig$;

-- Opportunity Engine — Initial Schema
-- Source of truth: DATABASE_SCHEMA.md (+ patches merged 2026-07-05
-- while assembling this migration: deprecation_reason on 6 structural
-- tables, scoring_config, model_routing_config — see AI_AGENTS.md §14)
--
-- Order follows true FK dependency, not thematic document order:
--   extensions → founder → pipeline_run → node tables → node_source_refs
--   → opportunity_candidate → composition/hypothesis_sources → opportunity
--   → outcome → edge → scoring_config → model_routing_config
--   → agent_execution_log → CHECK constraints → triggers → indexes

BEGIN;

-- ============================================================
-- 0. Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() fallback for PG <13
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector; enabled now, evidence.embedding column deferred to a follow-up migration (see evidence table comment)

-- ============================================================
-- 1. founder (no dependencies — GRAPH_SCHEMA.md §2.8)
-- ============================================================
CREATE TABLE founder (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expertise               text[],
  industries              text[],
  geography               text,
  capital_availability    text,
  distribution_assets     text[],
  audience_assets         text[],
  team_size               integer,
  constraints             text[],
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_updated_at         timestamptz NOT NULL DEFAULT now()
  -- No status, no confidence, no source_refs join rows — exempt
  -- per GRAPH_SCHEMA.md §2.8 (self-declared, not evidence-derived).
);

-- ============================================================
-- 2. pipeline_run (AGENT_EXECUTION_DAG.md §1 — depends on founder)
-- ============================================================
CREATE TABLE pipeline_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id      uuid NOT NULL REFERENCES founder(id),
  vertical        text NOT NULL,
  current_stage   text NOT NULL DEFAULT 'discovery',
  status          text NOT NULL DEFAULT 'running',
  failure_reason  text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- ============================================================
-- 3. Structural node tables (no cross-table deps except market
--    self-reference) — GRAPH_SCHEMA.md §2
-- ============================================================

CREATE TABLE evidence (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url_or_identifier  text NOT NULL,
  source_type               text NOT NULL,
  source_authority_tier     text NOT NULL,
  cluster_id                text,             -- nullable until first Reclustering run
  cluster_version           integer,          -- nullable until first Reclustering run
  extraction_method         text NOT NULL,
  extraction_confidence     real,
  extracted_fact            text NOT NULL,
  fetched_at                timestamptz NOT NULL,
  freshness                 real,
  verification_status       text NOT NULL DEFAULT 'unverified',
  status                    text NOT NULL DEFAULT 'active'
  -- NOTE: no `embedding` column yet, deliberately (Variant B).
  -- Reclustering and resurrection matching — the only two things that
  -- would use it — are both out of MVP scope per
  -- MVP_IMPLEMENTATION_PLAN.md §3. Committing to a vector dimension
  -- now (e.g. 1536) would hard-code an assumption about which NIM
  -- embedding model gets used before model_routing_config actually
  -- names one, and different embedding models use different
  -- dimensions (768/1024/1536 all common). This column — and its
  -- ivfflat index — get added in a follow-up migration once Phase 2
  -- picks a specific embedding model and records it in
  -- model_routing_config.
);

CREATE TABLE market (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                  text,
  market_size_estimate   numeric,
  growth_rate_estimate   real,
  maturity_stage         text NOT NULL,
  parent_market_id       uuid REFERENCES market(id),
  category_tags          text[],
  status                 text NOT NULL DEFAULT 'active',
  deprecation_reason     text,
  confidence             real,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audience (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                       text,
  demographic_profile         jsonb,
  behavioral_profile          jsonb,
  size_estimate               numeric,
  willingness_to_pay_signal   real,
  acquisition_channels_known  text[],
  status                      text NOT NULL DEFAULT 'active',
  deprecation_reason          text,
  confidence                  real,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_seen_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE problem (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                           text,
  severity_signal                 real,
  frequency_signal                real,
  current_workaround_description  text,
  problem_maturity                text NOT NULL,
  status                          text NOT NULL DEFAULT 'active',
  deprecation_reason              text,
  confidence                      real,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  last_seen_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE existing_solution (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                    text,
  positioning_summary      text,
  pricing_model            jsonb,
  estimated_market_share   real,
  strengths                text[],
  weaknesses               text[],
  distribution_channels    text[],
  status                   text NOT NULL DEFAULT 'active',
  deprecation_reason       text,
  confidence               real,
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_model (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                            text,
  model_type                       text NOT NULL,
  margin_profile                   real,
  operational_complexity_estimate  real,
  capital_intensity_estimate       real,
  status                           text NOT NULL DEFAULT 'active',
  deprecation_reason               text,
  confidence                       real,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  last_seen_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hypothesis (
  id                                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                                    text,
  statement                                text NOT NULL,
  gap_type                                 text NOT NULL,
  missing_data                             text[],
  supporting_evidence_strength             real,
  validation_score                        real,
  validation_computed_at_cluster_version   integer,
  status                                   text NOT NULL DEFAULT 'active',
  deprecation_reason                       text,
  confidence                               real,
  created_at                               timestamptz NOT NULL DEFAULT now(),
  last_seen_at                             timestamptz NOT NULL DEFAULT now()
  -- No solution_description column, ever — GRAPH_SCHEMA.md §2.7
  -- structural guardrail. Any future migration adding one must be
  -- rejected at schema review, not just at runtime.
);

-- ============================================================
-- 4. node_source_refs (generic evidence-citation join — depends
--    on evidence only; node_id is polymorphic, enforced at the
--    application layer, not by a real FK — DATABASE_SCHEMA.md §4)
-- ============================================================
CREATE TABLE node_source_refs (
  node_id       uuid NOT NULL,
  node_type     text NOT NULL CONSTRAINT chk_node_source_refs_node_type
                  CHECK (node_type IN ('market','audience','problem','existing_solution','business_model','hypothesis')),
  evidence_id   uuid NOT NULL REFERENCES evidence(id),
  PRIMARY KEY (node_id, evidence_id)
);

-- ============================================================
-- 5. opportunity_candidate (depends on pipeline_run)
-- ============================================================
CREATE TABLE opportunity_candidate (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid NOT NULL REFERENCES pipeline_run(run_id),
  opportunity_quality    real,
  founder_fit_score      real,
  founder_fit_rationale  text,
  venture_score          real,
  confidence_score       real,
  coverage               real,
  agreement              real,
  freshness              real,
  status                 text NOT NULL DEFAULT 'candidate',
  deprecation_reason     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. Hyperedge junction tables
-- ============================================================
CREATE TABLE opportunity_candidate_composition (
  candidate_id   uuid NOT NULL REFERENCES opportunity_candidate(id),
  node_id        uuid NOT NULL,
  node_type      text NOT NULL CONSTRAINT chk_composition_node_type CHECK (node_type IN ('market','audience','problem','hypothesis','business_model')),
  role           text NOT NULL CONSTRAINT chk_composition_role CHECK (role IN ('market','audience','problem','hypothesis','business_model')),
  PRIMARY KEY (candidate_id, role)
);

-- hypothesis_sources: existing_solution_id is genuinely nullable (a
-- hypothesis can cite an absence of solution coverage). A nullable
-- column cannot be part of a PRIMARY KEY in Postgres — PK columns are
-- implicitly NOT NULL, so the earlier draft's comment claiming
-- nullability while using it as a PK column was silently wrong the
-- moment this ran (Postgres would have coerced it to NOT NULL,
-- confirmed by actually running this migration). Fixed with a
-- surrogate key plus two partial unique indexes covering each case:
CREATE TABLE hypothesis_sources (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hypothesis_id          uuid NOT NULL REFERENCES hypothesis(id),
  problem_id             uuid NOT NULL REFERENCES problem(id),
  existing_solution_id   uuid REFERENCES existing_solution(id)
);
CREATE UNIQUE INDEX idx_hypothesis_sources_with_solution
  ON hypothesis_sources(hypothesis_id, problem_id, existing_solution_id)
  WHERE existing_solution_id IS NOT NULL;
CREATE UNIQUE INDEX idx_hypothesis_sources_without_solution
  ON hypothesis_sources(hypothesis_id, problem_id)
  WHERE existing_solution_id IS NULL;

-- ============================================================
-- 7. opportunity (terminal node — depends on opportunity_candidate)
-- ============================================================
CREATE TABLE opportunity (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promoted_from_candidate_id  uuid NOT NULL UNIQUE REFERENCES opportunity_candidate(id),
  venture_score               real NOT NULL,
  confidence_score            real NOT NULL,
  founder_fit_score           real NOT NULL,
  founder_fit_rationale       text,
  rationale_bullets           text[],
  risk_summary                text[],
  status                      text NOT NULL DEFAULT 'active',
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 8. outcome (append-only — depends on opportunity)
-- ============================================================
CREATE TABLE outcome (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id  uuid NOT NULL REFERENCES opportunity(id),
  signal_type     text NOT NULL,
  signal_strength text NOT NULL,
  reason_tag      text,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  confidence      real
);

-- ============================================================
-- 9. edge (generic binary edges — DATABASE_SCHEMA.md §6.1)
--    NOTE: `validates`/`invalidates` are NOT legal edge_type values
--    — removed per AI_AGENTS.md §19/§20, no node type ever backs them.
-- ============================================================
CREATE TABLE edge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_type   text NOT NULL,
  from_id     uuid NOT NULL,
  from_type   text NOT NULL,
  to_id       uuid NOT NULL,
  to_type     text NOT NULL,
  confidence  real,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 10. Configuration tables (versioned, append-only — no FKs)
--
-- Both tables originally used `version integer PRIMARY KEY` alone —
-- confirmed broken by actually inserting a second row: scoring_config
-- needs one row per (version, vertical), and model_routing_config
-- needs one row per (version, agent_name), so a single-column PK on
-- version rejected the second legitimate row every time. Fixed with
-- composite primary keys below.
-- ============================================================
CREATE TABLE scoring_config (
  version              integer NOT NULL,
  vertical             text NOT NULL,
  w1_demand            real NOT NULL,
  w2_hypothesis        real NOT NULL,
  w3_margin            real NOT NULL,
  w4_feasibility       real NOT NULL,
  w5_distribution      real NOT NULL,
  w6_timing            real NOT NULL,
  quality_weight       real NOT NULL DEFAULT 0.7,
  founder_fit_weight   real NOT NULL DEFAULT 0.3,
  effective_from       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, vertical)
);

CREATE TABLE model_routing_config (
  version         integer NOT NULL,
  agent_name      text NOT NULL,
  nim_model_id    text NOT NULL,
  tier            text NOT NULL,
  effective_from  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version, agent_name)
);

-- ============================================================
-- 11. agent_execution_log (AGENT_EXECUTION_DAG.md §1 —
--     depends on pipeline_run and opportunity_candidate)
-- ============================================================
CREATE TABLE agent_execution_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES pipeline_run(run_id),
  candidate_id          uuid REFERENCES opportunity_candidate(id),
    -- NULL for pre-Composition stages; required (app-enforced) from
    -- Composition onward per AGENT_EXECUTION_DAG.md §2.
  agent_name            text NOT NULL,
  model_used            text,
  input_hash            text,
  output_hash           text,
  started_at            timestamptz NOT NULL,
  completed_at          timestamptz,
  status                text NOT NULL,
  attempt_number        integer NOT NULL DEFAULT 1,
  cost_estimate         numeric,
  graph_mutation_count  integer
);

-- ============================================================
-- 12. CHECK constraints (DATABASE_SCHEMA.md §5)
-- ============================================================
ALTER TABLE pipeline_run          ADD CONSTRAINT chk_pipeline_run_status CHECK (status IN ('running','completed','failed','insufficient_evidence'));
ALTER TABLE market                ADD CONSTRAINT chk_market_status CHECK (status IN ('active','deprecated','archived','resurrection_candidate','merged'));
ALTER TABLE audience              ADD CONSTRAINT chk_audience_status CHECK (status IN ('active','deprecated','archived','resurrection_candidate','merged'));
ALTER TABLE problem               ADD CONSTRAINT chk_problem_status CHECK (status IN ('active','deprecated','archived','resurrection_candidate','merged'));
ALTER TABLE existing_solution     ADD CONSTRAINT chk_existing_solution_status CHECK (status IN ('active','deprecated','archived','resurrection_candidate','merged'));
ALTER TABLE business_model        ADD CONSTRAINT chk_business_model_status CHECK (status IN ('active','deprecated','archived','resurrection_candidate','merged'));
ALTER TABLE hypothesis            ADD CONSTRAINT chk_hypothesis_status CHECK (status IN ('active','deprecated','archived','resurrection_candidate','merged'));
ALTER TABLE evidence              ADD CONSTRAINT chk_evidence_status CHECK (status IN ('active','stale','superseded'));
ALTER TABLE evidence              ADD CONSTRAINT chk_evidence_verification CHECK (verification_status IN ('unverified','verified','failed_verification'));
ALTER TABLE opportunity_candidate ADD CONSTRAINT chk_opportunity_candidate_status CHECK (status IN ('candidate','deprecated','promoted'));
ALTER TABLE opportunity           ADD CONSTRAINT chk_opportunity_status CHECK (status IN ('active','superseded'));

-- ============================================================
-- 13. Append-only enforcement on outcome (DATABASE_SCHEMA.md §7)
-- ============================================================
CREATE OR REPLACE FUNCTION forbid_outcome_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'outcome rows are append-only — insert a new row, do not UPDATE or DELETE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_outcome_no_update
  BEFORE UPDATE OR DELETE ON outcome
  FOR EACH ROW EXECUTE FUNCTION forbid_outcome_mutation();

-- ============================================================
-- 14. Indexes (DATABASE_SCHEMA.md §6.1, §9; AGENT_EXECUTION_DAG.md §1)
-- ============================================================
CREATE INDEX idx_edge_from ON edge(from_id, edge_type);
CREATE INDEX idx_edge_to   ON edge(to_id, edge_type);
CREATE UNIQUE INDEX idx_promotes_once ON edge(from_id) WHERE edge_type = 'promotes';

CREATE INDEX idx_node_source_refs_evidence ON node_source_refs(evidence_id);

CREATE INDEX idx_opportunity_candidate_run ON opportunity_candidate(run_id, status);

CREATE INDEX idx_evidence_cluster ON evidence(cluster_id, cluster_version);
-- idx_evidence_embedding (ivfflat) deferred along with the embedding
-- column itself — see evidence table comment above.

CREATE INDEX idx_market_active            ON market(id)             WHERE status = 'active';
CREATE INDEX idx_audience_active          ON audience(id)           WHERE status = 'active';
CREATE INDEX idx_problem_active           ON problem(id)            WHERE status = 'active';
CREATE INDEX idx_existing_solution_active ON existing_solution(id)  WHERE status = 'active';
CREATE INDEX idx_business_model_active    ON business_model(id)     WHERE status = 'active';
CREATE INDEX idx_hypothesis_active        ON hypothesis(id)         WHERE status = 'active';

CREATE INDEX idx_opportunity_active ON opportunity(id) WHERE status = 'active';

CREATE INDEX idx_execlog_run_candidate ON agent_execution_log(run_id, candidate_id, agent_name);

COMMIT;


-- -----------------------------------------------------------------------------
-- 002_existing_solution_attribution_flag.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 002_existing_solution_attribution_flag.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 003_node_source_refs_evidence_polarity.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 003_node_source_refs_evidence_polarity.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 004_pipeline_search_log.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 004_pipeline_search_log.sql'; END $mig$;

-- Adds pipeline_search_log — the durable audit trail that makes
-- AI_AGENTS.md §6's "log an explicit 'no further sources available'
-- result" invariant actually checkable after the fact. Before this
-- migration, Validation Collector's active-search step (wired via
-- pipeline/searchForHypothesisEvidence.ts) returned the log payload
-- to its caller for inspection but nothing persisted; a future
-- Orchestrator-side "did Validation actually search this hypothesis?"
-- audit had no row to query against.
--
-- Schema shape is copied verbatim from the proposal in
-- searchForHypothesisEvidence.ts's header — no changes from the shape
-- the code already constructs, just moving it from an in-memory
-- payload to a persisted row.
--
-- Design choices:
--   * hypothesis_id is nullable, NOT foreign-keyed to hypothesis(id).
--     Nullable: pre-hypothesis searches (Discovery/Expansion-side use,
--     if we later add one) legitimately have no hypothesis to attribute
--     the search to. No FK: matches node_source_refs's polymorphic
--     pattern (§4) — Validation's search is Hypothesis-scoped in the
--     current use, but the log itself is Data Pipeline audit, not part
--     of the graph. Keeping it unlinked avoids cascading deletes we
--     don't want if a Hypothesis is later archived.
--   * run_id IS FK — every search happens inside a pipeline_run and
--     that link needs to survive; if the run is retained, so is the
--     search log; if the run is somehow removed, the log rows go
--     with it (they're only meaningful in that run's context).
--   * connector column is text, not enum-constrained (yet). Reason:
--     we currently have one search-capable connector (tavily-search)
--     but there is no reason the invariant needs to force a CHECK
--     constraint at this stage — misspellings will be caught by
--     downstream reporting queries, not silently swallow bad data.
--     If/when a second connector lands, adding a CHECK is a one-line
--     follow-up migration.
BEGIN;

CREATE TABLE pipeline_search_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES pipeline_run(run_id),
  hypothesis_id uuid,
  connector     text NOT NULL,
  query_text    text NOT NULL,
  result_count  integer NOT NULL,
  executed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pipeline_search_log_run
  ON pipeline_search_log(run_id, hypothesis_id);

COMMIT;


-- -----------------------------------------------------------------------------
-- 005_opportunity_candidate_confidence_mode2.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 005_opportunity_candidate_confidence_mode2.sql'; END $mig$;

-- Adds the Confidence Mode 2 breakdown columns to opportunity_candidate.
--
-- Context: opportunity_candidate already carries `confidence_score`,
-- `coverage`, `agreement`, `freshness` from migration 001. Those
-- pre-existing generic columns were declared under the ORIGINAL Mode 2
-- design (round 1): coverage as a fraction, agreement as an unweighted
-- mean across all 5 composition slots, all three components blended
-- into confidence_score.
--
-- The 4-candidate audit bench (scripts/output/confidence_mode2_audit_data.json,
-- previewConfidenceMode2OnAudit.ts round 1) surfaced that round-1
-- design compressed every real candidate into a nearly-indistinguishable
-- 0.99+ range because contradicting evidence only ever lands on the
-- hypothesis slot under the current pipeline (Validation Collector is
-- the only writer that ever sets polarity='contradicting'; every other
-- slot takes the DB default 'supporting' from migration 003). Averaging
-- polarity across 5 slots attenuated the only real signal 5x.
--
-- Revised design (confidenceMode2.ts round 2):
--   * coverage becomes a BINARY GATE — all-5-slots-filled check per
--     the §8 invariant, not an averaged component. Different semantics
--     from the old `coverage real` column, so a new column with a
--     different name.
--   * agreement is computed EXCLUSIVELY from the hypothesis slot's
--     polarity split. Different formula from the old `agreement real`
--     column, so a new column with a different name.
--   * freshness stays a mean recency-decay but is NO LONGER blended
--     into confidence_score (its DECAY_CONSTANT_DAYS is still
--     provisional — see scripts/freshnessBench.ts). Kept as a
--     visible debug field so auditors can see what the curve produced.
--   * confidence_score (existing column) now stores the aggregate
--     (in this revision: == confidence_agreement).
--   * incomplete_composition is a new short-circuit flag surfaced
--     to Compression so it can distinguish "not scored yet" from
--     "scored but Composition gap-flagged."
--
-- Legacy columns (`coverage`, `agreement`, `freshness`) are LEFT IN
-- PLACE, NOT DROPPED, NOT WRITTEN TO. They currently hold NULL for
-- every existing candidate (round 1 never persisted anywhere) and no
-- reader references them yet. A follow-up cleanup migration can drop
-- them after this revision has run in production long enough to
-- confirm no external consumer picked them up in the interim. Same
-- principle as everywhere else in this project — never destroy in
-- the same migration that supersedes; leave a reversible interval.
--
-- Column semantics:
--   confidence_coverage_gate boolean nullable
--     NULL  = Mode 2 has not yet run for this candidate
--     TRUE  = all 5 composition slots resolved (§8 invariant held);
--             agreement/freshness/confidence_score are computed
--     FALSE = at least one slot was is_null; agreement/freshness/
--             confidence_score are NULL (short-circuit path)
--   incomplete_composition boolean nullable
--     Convenience mirror of `confidence_coverage_gate = FALSE`.
--     Kept separate so a Compression-side reader doesn't have to
--     encode the "false != null" quirk of Postgres boolean columns
--     to detect the short-circuit case. NULL = not yet run.
--   confidence_agreement real nullable
--     hypothesis-slot distinctSupporting / (distinctSupporting +
--     distinctContradicting). NULL when the gate failed OR the
--     hypothesis slot has zero cited evidence.
--   confidence_freshness real nullable
--     Mean of 1/(1 + age_days / DECAY_CONSTANT_DAYS) across the
--     candidate's linked evidence. NOT blended into confidence_score
--     in this revision — surfaced for visibility only. NULL when
--     candidate has zero linked evidence or gate failed.
--
-- Concurrency safety (AGENT_EXECUTION_DAG.md §5):
--   These columns are exclusively written by Confidence Mode 2
--   (stage 10a). FounderFit (stage 10b) writes founder_fit_score and
--   founder_fit_rationale. The two branches touch DISJOINT column
--   sets on the same candidate row and both use targeted
--   `UPDATE ... SET <owned columns only>` statements — Postgres'
--   SET clause is inherently column-scoped, so the concurrent-write
--   invariant is enforced at the query-construction level, exactly
--   as §5 requires.
BEGIN;

ALTER TABLE opportunity_candidate
  ADD COLUMN confidence_coverage_gate boolean,
  ADD COLUMN incomplete_composition   boolean,
  ADD COLUMN confidence_agreement     real,
  ADD COLUMN confidence_freshness     real;

-- No CHECK constraint on the boolean columns (Postgres already
-- enforces boolean-or-null typing). No CHECK on confidence_agreement
-- / confidence_freshness ranges either — the pure function guarantees
-- [0, 1] on write, and clamping at the SQL layer would only ever
-- catch a bug in that guarantee, at which point failing the write
-- entirely is more useful than a silent CHECK-triggered constraint
-- error mid-transaction. Same discipline as validation_score on
-- hypothesis (§7): trust the writer's contract, don't double-clamp.

COMMIT;


-- -----------------------------------------------------------------------------
-- 006_dag_run_state.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 006_dag_run_state.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 007_evidence_source_published_at.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 007_evidence_source_published_at.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 008_evidence_vertical.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 008_evidence_vertical.sql'; END $mig$;

-- Adds vertical (nullable text) to evidence.
--
-- Design decision (Task E): evidence stays a shared corpus but is
-- tagged by vertical so Discovery Agent can scope its read to only
-- the corpus relevant to the run's target vertical. Cross-run reuse
-- inside the SAME vertical stays intact — two orders on
-- shopify_subscriptions share ingested evidence — which is what makes
-- Tavily cost proportional to vertical count, not order count.
--
-- Nullable because pre-existing seed rows may not always be tagged
-- cleanly (see backfill below); a null vertical means "unclassified"
-- and is defensively filtered OUT by Discovery going forward (no
-- silent leaks into any run).
--
-- Backfill logic in this migration:
--   * Rows tagged in URL with `probe=b2b_customer_support_saas`
--     (from the earlier generalization probe) → b2b_customer_support_saas
--   * Everything else → shopify_subscriptions (the only other vertical
--     the current corpus was collected for)
-- If ambiguous rows ever enter the corpus later, a follow-up
-- classification step can populate vertical; for now this covers the
-- entire existing corpus deterministically.

BEGIN;

ALTER TABLE evidence
  ADD COLUMN vertical text;

UPDATE evidence
   SET vertical = 'b2b_customer_support_saas'
 WHERE source_url_or_identifier LIKE '%probe=b2b_customer_support_saas%';

UPDATE evidence
   SET vertical = 'shopify_subscriptions'
 WHERE vertical IS NULL;

-- Fast lookup for the Discovery read path — vertical + status is the
-- hot filter shape.
CREATE INDEX idx_evidence_vertical_status ON evidence (vertical, status);

COMMIT;


-- -----------------------------------------------------------------------------
-- 009_node_pipeline_run_id.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 009_node_pipeline_run_id.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 010_founder_intake_state.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 010_founder_intake_state.sql'; END $mig$;

-- Adds intake_state (jsonb, nullable) to the founder table.
--
-- Rationale: the Founder Intake Engine needs per-field asked-tracking
-- that is distinct from the field's actual value. Without this column
-- the system cannot distinguish "field was asked and the founder said
-- they have nothing" from "field was never asked" — the same
-- null-vs-missing distinction that drove the P1.1/P1.2/P1.3/
-- capitalAvailability fixes elsewhere in the codebase.
--
-- The column stores a FounderIntakeState JSON blob:
--   {
--     "fields": {
--       "expertise":           { "asked": bool, "askedAt": ISO|null, "capTerminated": bool, "followUpAsked": bool, "depth": {"wordCount": n}|null },
--       "distributionAssets":  { ... },
--       "capitalAvailability": { ... }
--     },
--     "questionCount": n,
--     "completedAt": ISO|null,
--     "contradictionFlags": [
--       { "detectedAt": ISO, "field1": str, "snippet1": str, "field2": str, "snippet2": str, "message": str, "resolved": bool }
--     ]
--   }
--
-- Nullable: existing founder rows have no intake history; NULL means
-- "intake not started yet", which the engine handles as an all-unasked
-- initial state. A NOT NULL default would require back-filling a
-- well-formed JSON blob, which is noise for the single existing row.
--
-- JSONB (not JSON): enables GIN-index support if future queries need
-- to filter on intake completion state across many founders at once.
-- Currently no index is added — single-founder queries by id are
-- the only access pattern today.

BEGIN;

ALTER TABLE founder ADD COLUMN intake_state jsonb;

COMMIT;


-- -----------------------------------------------------------------------------
-- 011_founder_evidence.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 011_founder_evidence.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 012_founder_auth_link.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 012_founder_auth_link.sql'; END $mig$;

-- Links the founder row to a Supabase Auth user.
--
-- auth_user_id is nullable and has no default so that:
--   (a) The legacy seed founder (fd88ecae-5bf3-4289-a13e-6278a484eed9) used in
--       integration tests keeps auth_user_id = NULL and remains unaffected.
--   (b) The auth middleware can distinguish "no founder yet" (auth_user_id not
--       matched) from "founder exists" cleanly, without touching legacy rows.
--
-- UNIQUE ensures one founder row per Supabase Auth identity.
-- The callback route (POST /auth/callback) inserts the new row on first login.

BEGIN;

ALTER TABLE founder
  ADD COLUMN auth_user_id uuid UNIQUE;

COMMIT;


-- -----------------------------------------------------------------------------
-- 013_fix_founder_evidence_check_constraint.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 013_fix_founder_evidence_check_constraint.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 014_agent_execution_log_nullable_run_id.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 014_agent_execution_log_nullable_run_id.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 015_pipeline_run_stripe_session.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 015_pipeline_run_stripe_session.sql'; END $mig$;

-- Adds stripe_session_id to pipeline_run for Stripe Checkout idempotency.
-- NULL = run created by direct orchestrate call (not via Stripe payment).
-- Non-null = run was created via Stripe Checkout; UNIQUE prevents a
--            duplicate run if Stripe delivers the webhook more than once
--            (Stripe guarantees at-least-once delivery).

BEGIN;

ALTER TABLE pipeline_run
  ADD COLUMN stripe_session_id TEXT UNIQUE;

COMMIT;


-- -----------------------------------------------------------------------------
-- 016_agent_execution_log_raw_output.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 016_agent_execution_log_raw_output.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 017_founder_evidence_team_size_geography.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 017_founder_evidence_team_size_geography.sql'; END $mig$;

-- Widens founder_evidence_target_field_check to accept the two new MUST-fill
-- fields wired into the Intake Engine + FounderFit grounding: team_size and
-- geography. The three original values (expertise, distribution_assets,
-- capital_availability) remain valid.
--
-- Founder.team_size (int?) and Founder.geography (text?) already exist on the
-- founder table since migration 001 — no column adds needed. Only the
-- founder_evidence.target_field enum-in-a-CHECK needs to catch up.
--
-- Run against app DB (src/db/migrations/, manual apply — same stream as 013).

BEGIN;

ALTER TABLE founder_evidence
  DROP CONSTRAINT founder_evidence_target_field_check;

ALTER TABLE founder_evidence
  ADD CONSTRAINT founder_evidence_target_field_check
    CHECK (target_field IN (
      'expertise',
      'distribution_assets',
      'capital_availability',
      'team_size',
      'geography'
    ));

COMMIT;


-- -----------------------------------------------------------------------------
-- 018_opportunity_rationale_dag_step.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 018_opportunity_rationale_dag_step.sql'; END $mig$;

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


-- -----------------------------------------------------------------------------
-- 019_pipeline_run_resolution_and_retry.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 019_pipeline_run_resolution_and_retry.sql'; END $mig$;

-- Adds founder-facing post-run resolution + retry-chain tracking to
-- pipeline_run. Motivated by the "insufficient_evidence terminal state"
-- flow (surfaced by 548434e): when a paid analysis honestly returns
-- 'no opportunity cleared the bar', the founder gets a one-time choice
-- to refund the €15 or take one free retry, rather than needing to
-- email support.
--
-- Columns:
--   resolution
--     NULL       — the founder hasn't taken an action yet on this run
--                  (either the run isn't terminal, or the offer is still
--                  outstanding).
--     'refunded' — refund_stripe_refund_id set below.
--     'retried'  — free retry taken; a new pipeline_run has been created
--                  with parent_run_id pointing to THIS row.
--     'accepted' — founder dismissed the offer / took the result as-is
--                  (reserved; UI may add an explicit "keep the result"
--                  affordance later without needing a second migration).
--     Once set, the offer is not shown again on this run — resolution is
--     effectively a one-time-choice latch.
--
--   resolved_at
--     Timestamp of the resolution transition. Auditable.
--
--   refund_stripe_refund_id
--     Stripe's refund object id (re_...) returned by stripe.refunds.create.
--     Preserved for double-refund guard + reconciliation with Stripe
--     dashboard. Set together with resolution='refunded'.
--
--   parent_run_id
--     Points from a free-retry run back to the run whose "retry" the
--     founder took. Cap enforcement (currently 1 free retry per paid
--     checkout — see api.ts POST /runs/:runId/free-retry) walks this
--     chain up to the root run (the run with stripe_session_id set) and
--     counts descendants. FK to pipeline_run(run_id); ON DELETE SET NULL
--     so deleting a run doesn't cascade-orphan its retry.
--
-- Index: parent_run_id lookup happens on every free-retry decision and
-- every refund walk-up, so an explicit index (Postgres doesn't
-- auto-index the referencing side of a FK).

BEGIN;

ALTER TABLE pipeline_run
  ADD COLUMN resolution TEXT
    CHECK (resolution IS NULL OR resolution IN ('refunded', 'retried', 'accepted')),
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN refund_stripe_refund_id TEXT,
  ADD COLUMN parent_run_id UUID REFERENCES pipeline_run(run_id) ON DELETE SET NULL;

CREATE INDEX idx_pipeline_run_parent_run_id ON pipeline_run(parent_run_id);

COMMIT;


-- -----------------------------------------------------------------------------
-- 020_pipeline_run_run_type.sql
-- -----------------------------------------------------------------------------
DO $mig$ BEGIN RAISE NOTICE 'Applying 020_pipeline_run_run_type.sql'; END $mig$;

-- Adds run_type discriminator to pipeline_run so we can host the free
-- "Market Signal Check" alongside paid full analyses on the same table
-- without spinning up a parallel execution path.
--
-- run_type:
--   'full_analysis' — the paid €15 flow. Default so every existing row
--                     back-fills correctly and every code path that
--                     hasn't been signal-check-aware yet keeps behaving
--                     as before.
--   'signal_check'  — the free, Discovery-only flow. sequencing.advance()
--                     stops after 'discovery' for these runs (no
--                     Expansion+); the result surfaces market count +
--                     growth signal only. Audiences/problems/hypotheses
--                     are the paid unlock's value and are never produced
--                     on this branch (Discovery only writes Market rows).
--
-- Uniqueness: one free check per (founder, vertical). A FAILED signal
-- check does not consume the slot — founders can retry after a genuine
-- error. Any non-failed row (running/completed/insufficient_evidence)
-- does consume it, and a second attempt is blocked at the API layer
-- with 409, pointing the founder at the paid checkout instead.

BEGIN;

ALTER TABLE pipeline_run
  ADD COLUMN run_type TEXT NOT NULL DEFAULT 'full_analysis'
    CHECK (run_type IN ('full_analysis', 'signal_check'));

CREATE UNIQUE INDEX idx_pipeline_run_free_signal_check
  ON pipeline_run (founder_id, vertical)
  WHERE run_type = 'signal_check' AND status <> 'failed';

CREATE INDEX idx_pipeline_run_run_type
  ON pipeline_run (run_type);

COMMIT;


DO $$ BEGIN RAISE NOTICE '===== All 20 migrations applied ====='; END $$;

-- =============================================================================
-- Post-apply verification (run and inspect result)
-- =============================================================================
SELECT
  '006_dag_run_state (table)'          AS check_name, to_regclass('public.dag_run_state')          AS present
UNION ALL SELECT '001 (founder table)',              to_regclass('public.founder')
UNION ALL SELECT '001 (pipeline_run table)',         to_regclass('public.pipeline_run')
UNION ALL SELECT '001 (opportunity_candidate)',      to_regclass('public.opportunity_candidate')
UNION ALL SELECT '001 (agent_execution_log)',        to_regclass('public.agent_execution_log')
UNION ALL SELECT '001 (model_routing_config)',       to_regclass('public.model_routing_config')
UNION ALL SELECT '004 (pipeline_search_log)',        to_regclass('public.pipeline_search_log')
UNION ALL SELECT '010 (founder_intake_state)',       to_regclass('public.founder_intake_state')
UNION ALL SELECT '011 (founder_evidence)',           to_regclass('public.founder_evidence');
-- Every row's `present` column should be non-NULL (the table's own name).

-- Column-level checks for the last few migrations:
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pipeline_run'
  AND column_name IN (
    'stripe_session_id',              -- 015
    'resolution',                     -- 019
    'resolved_at',                    -- 019
    'refund_stripe_refund_id',        -- 019
    'parent_run_id',                  -- 019
    'run_type'                        -- 020
  )
ORDER BY column_name;
-- Expect 6 rows: parent_run_id, refund_stripe_refund_id, resolution,
--   resolved_at, run_type, stripe_session_id.

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'founder'
  AND column_name IN ('auth_user_id', 'intake_state');
-- Expect 2 rows.

-- Extensions check (should show both enabled):
SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgcrypto', 'vector');
