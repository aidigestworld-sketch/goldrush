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
