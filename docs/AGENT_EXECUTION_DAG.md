# Opportunity Engine — AGENT_EXECUTION_DAG.md
## Run Order, Transaction Boundaries, Retry and Failure Semantics

This document takes the dependency DAG declared via `depends_on:` in
AI_AGENTS.md §17 and specifies how it actually executes: what commits
atomically, what happens on failure, how the one parallel branch is
handled safely, and what happens when two runs touch the graph at the
same time. It resolves the `pipeline_run` gap flagged (and left open)
in every prior document.

---

## 0. Two Gaps Resolved Here, One Newly Surfaced

**Resolved: `pipeline_run` table** — flagged as missing in
DATABASE_SCHEMA.md §6 (Orchestrator's own storage) and again in
AI_AGENTS.md §13. Schema in §1 below.

**Resolved: what "transaction" means per stage** — every prior
document referenced stage handoffs and the Compression promotion
transaction (DATABASE_SCHEMA.md §8) but never stated the general rule
for the other 12 stages. §3 below.

**Newly surfaced: cross-run deduplication.** Building the execution
model exposed something none of the prior three documents addressed:
two concurrent `pipeline_run`s (different founders, possibly
overlapping verticals) can both have Discovery independently create a
near-duplicate `Market` row for the same real-world market, in two
different transactions, at the same time. Nothing in GRAPH_SCHEMA_SPEC.md
or DATABASE_SCHEMA.md prevents this — Memory Agent's node-matching
(resurrection/merge logic) is a scheduled batch process, not a
same-instant guard. This is flagged and given an explicit,
deliberately-scoped-down answer in §7, not silently patched.

---

## 1. `pipeline_run` and `agent_execution_log`

```sql
CREATE TABLE pipeline_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id      uuid NOT NULL REFERENCES founder(id),
  vertical        text NOT NULL,
  current_stage   text NOT NULL DEFAULT 'discovery',
  status          text NOT NULL DEFAULT 'running',
    -- running | completed | failed | insufficient_evidence
  failure_reason  text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
ALTER TABLE pipeline_run ADD CONSTRAINT chk_status
  CHECK (status IN ('running','completed','failed','insufficient_evidence'));

CREATE TABLE agent_execution_log (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES pipeline_run(run_id),
  agent_name            text NOT NULL,
  model_used            text,             -- NIM model id; NULL for deterministic agents (Filtering, Composition, Scoring, Compression)
  input_hash            text,
  output_hash           text,
  started_at            timestamptz NOT NULL,
  completed_at          timestamptz,
  status                text NOT NULL,     -- success | failed | retried
  attempt_number        integer NOT NULL DEFAULT 1,
  cost_estimate         numeric,
  graph_mutation_count  integer
);
```

`agent_execution_log` is the direct answer to what the NVIDIA-framed
draft called "Observability" (AI_AGENTS.md §20 rejected two of that
draft's ideas; this part of it was never rejected, just not yet
given a table — done here).

---

## 2. Stage Registry

One row per DAG node from AI_AGENTS.md §17, with execution-specific
columns added.

| # | Stage (agent) | depends_on | Deterministic? | Max attempts | Timeout |
|---|---|---|---|---|---|
| 1 | Discovery | — | no (LLM extraction) | 3 | 5 min |
| 2 | Expansion | Discovery | no | 3 | 5 min |
| 3 | Filtering | Expansion | **yes** | 1 (retry = re-run, always safe) | 30 s |
| 4 | CompetitiveAnalysis | Filtering | no | 3 | 10 min |
| 5 | Hypothesis | CompetitiveAnalysis | no (bounded synthesis) | 3 | 5 min |
| 6 | Validation (Collector) | Hypothesis | no | 3 | 10 min |
| 7 | Confidence [Mode 1: Hypothesis] | Validation | **yes** (pure aggregation over already-gathered evidence) | 1 | 30 s |
| 8 | Composition | Confidence [Mode 1] | **yes** | 1 | 30 s |
| 9 | Scoring | Composition | **yes** | 1 | 30 s |
| 10a | Confidence [Mode 2: Candidate] | Scoring | **yes** | 1 | 30 s |
| 10b | FounderFit | Scoring | no (comparative reasoning) | 3 | 3 min |
| 11 | Compression | 10a + 10b (join) | **yes** (tie-break is pure function; phrasing sub-step is not — see note) | 1 | 1 min |

**"Deterministic" here means**: given the same committed graph state
as input, re-running produces the same output, so a failed attempt can
simply be retried without any special idempotency handling — the
retry is safe by construction, not because of extra bookkeeping.
Compression's tie-break math is deterministic; the optional LLM
phrasing of `rationale_bullets`/`risk_summary` (AI_AGENTS.md §16) is
not — if that phrasing step fails after the tie-break already
committed, retry only the phrasing sub-step, not the whole
Compression stage (see §3's transaction note).

Memory is intentionally absent from this table — per AI_AGENTS.md
§12/§17, it is not part of any `pipeline_run`'s DAG at all.

---

## 3. Transaction Boundary Rule

**One rule, applied uniformly**: each stage's graph writes and its
`pipeline_run.current_stage` advance commit in the **same database
transaction**. Concretely:

```
BEGIN;
  <stage's INSERT/UPDATE statements, per that agent's contract in AI_AGENTS.md>
  UPDATE pipeline_run SET current_stage = '<next stage>' WHERE run_id = :run_id;
  INSERT INTO agent_execution_log (...) VALUES (...);
COMMIT;
```

This means there is no window where a stage's graph writes are durable
but the run doesn't yet reflect having completed that stage, or vice
versa — a crash anywhere in this transaction rolls the whole thing
back, and the retry logic in §4 sees the run still sitting at the
prior `current_stage`, exactly as if the attempt had never started.

**Consequence for retries**: because of this rule, no stage needs a
separate application-level idempotency key to be retry-safe *within
its own transaction*. The one thing this rule does **not** cover is
cross-run duplication (§7) — that's a different problem (two separate
transactions, from two separate runs, each individually valid).

**Compression's sub-step exception**: the promotion transaction
(DATABASE_SCHEMA.md §8) already is one atomic block for the
tie-break + promotion. If rationale/risk-summary phrasing is done via
a separate LLM call, it should be a **second, smaller transaction**
that only `UPDATE`s the already-created `opportunity.rationale_bullets`
/`risk_summary` — the promotion itself must not be held open (and its
row locks extended) while waiting on an LLM call.

---

## 4. Retry Policy

- **Deterministic stages** (Filtering, Confidence, Composition,
  Scoring, Compression's tie-break): 1 nominal attempt; on
  infrastructure failure (DB timeout, network blip), retry
  immediately — same input, same output, no special handling.
- **LLM-based stages** (Discovery, Expansion, CompetitiveAnalysis,
  Hypothesis, Validation Collector, FounderFit): up to 3 attempts,
  exponential backoff (e.g. 2s / 8s / 30s). Because these are **not**
  guaranteed deterministic (model sampling variance), a retry may
  produce a different — not just re-confirmed — set of nodes. This is
  acceptable *only* because of the transaction rule in §3: a failed
  attempt never partially commits, so a retry either fully replaces
  the attempt's output or the run fails cleanly — it never blends two
  partial attempts into one inconsistent graph state.
- **Exhausted retries**: `pipeline_run.status = 'failed'`,
  `failure_reason` set to `'<stage_name>_exhausted_retries'`. No
  partial `Opportunity` is ever produced — this is the same "no
  partial output" invariant already stated in AI_AGENTS.md §13, now
  given a concrete failure state to land in.
- **`insufficient_evidence` vs `failed`**: reserved for the case where
  every stage *executed successfully* but no Hypothesis cleared the
  Confidence gate (AI_AGENTS.md §7 Mode 1), so there is nothing for
  Composition to compose. This is not an error — it's a valid,
  expected outcome for a thin vertical — and should be surfaced to the
  user distinctly from an actual failure.

---

## 5. Parallel Branch Execution (Stages 10a/10b)

Confidence [Mode 2] and FounderFit both depend only on Scoring (§2,
row 9) and write disjoint columns on the same `opportunity_candidate`
row:

```
Scoring commits (opportunity_quality set)
        │
        ├──→ Confidence [Mode 2]  (writes confidence_score, coverage, agreement, freshness)
        │
        └──→ FounderFit            (writes founder_fit_score, founder_fit_rationale)
        │
        ▼
   Compression (waits for BOTH to report success)
```

**Concurrency safety requirement**: both branches MUST write via
targeted column `UPDATE`s (`SET confidence_score = ...`, not a
full-row replace built from a stale in-memory copy of the row).
Because the two branches touch disjoint columns, this is safe to run
truly concurrently without a lock conflict — but only if neither
implementation does a read-modify-write of the whole row, which would
create a lost-update race (branch B's write silently overwriting
branch A's column with a stale value). This constraint should be
enforced at the query-construction level, not left as an assumption.

**Join semantics**: the Orchestrator marks Compression as
"ready" only when *both* `agent_execution_log` entries for this
`run_id`+`opportunity_candidate` show `status = 'success'`. If one
branch fails and exhausts retries while the other succeeds, the whole
run fails (§4) — Compression never runs on a half-scored candidate.

---

## 6. Concurrent Runs (different founders / verticals)

Separate `pipeline_run`s are fully independent at the transaction
level — nothing here requires locking across runs, and there's no
reason to serialize two founders' runs against each other. They share
only the underlying structural graph (`market`, `audience`, `problem`,
`evidence`, etc.), which is the intended design — that's how the graph
accumulates value across users over time (v1's whole "memory over
statelessness" principle). The one consequence of that sharing is §7.

---

## 7. Cross-Run Deduplication (newly surfaced gap, scoped answer)

**The problem**: two concurrent runs' Discovery/Expansion stages can
each independently create a `Market`/`Audience`/`Problem` row
describing the same real-world entity, in two separate transactions,
neither aware of the other. The per-stage transaction rule (§3) makes
each individual write safe and consistent — it does not make the two
writes *non-duplicative*.

**Decision for MVP: accept transient duplication, resolve via Memory's
existing batch merge, not synchronous dedup.** Reasoning:

- A synchronous dedup check (embedding similarity lookup before every
  Discovery/Expansion insert) adds real latency and complexity to
  every run, for a failure mode (two founders independently
  discovering the same market in the same time window) that's likely
  rare at MVP scale (v1 MVP.md scope: one vertical, limited
  concurrent users).
- The graph already has the right mechanism for this — Memory Agent's
  node-matching produces `merged` status (GRAPH_SCHEMA_SPEC.md §4.1)
  on its next scheduled cycle. Duplicate rows are transient (hours,
  not permanent), not silently lost — both remain queryable and
  citable via `source_refs` until merged, consistent with the
  never-hard-delete philosophy already established everywhere else in
  this spec.
- Scoring/Composition operating on a not-yet-merged duplicate isn't
  harmful — it just means two `OpportunityCandidate`s might
  temporarily exist for what's really one underlying opportunity, and
  ordinary Compression tie-break logic (or a subsequent run) resolves
  which one wins, same as any other pair of competing candidates.

**This is a deliberate scope decision, not an oversight** — flagged
explicitly because it's exactly the kind of thing that's cheap to
revisit later (add a synchronous similarity check to Discovery/
Expansion's write path) if concurrent-run volume grows enough for
duplicate density to become a real problem, and expensive to have
silently ignored if it had been assumed away instead.

---

## 8. Summary

`pipeline_run` and `agent_execution_log` give the Orchestrator (and
you) a concrete place to see run state and per-stage history — closing
a gap flagged twice before. The transaction rule in §3 (stage writes +
`pipeline_run` advance commit together) is what makes every retry in
§4 safe without extra idempotency machinery, and is the reason the one
parallel branch (§5) can run concurrently without a locking scheme
more complicated than "write to disjoint columns only." Cross-run
duplication (§7) is the one gap this pass surfaced that is *not* fully
closed — deliberately deferred to Memory's existing batch-merge
mechanism rather than solved synchronously, with the tradeoff stated
plainly rather than assumed.
