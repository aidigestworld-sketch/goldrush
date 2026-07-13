# Opportunity Engine — AI_AGENTS.md
## Contract Specification (not narrative) — v2, post-architect-review

Every agent below is defined only as: `owns / depends_on / input /
output / writes / reads / invariants`. `owns` and `depends_on` are new
in this revision, added in response to architect review — see §0.

---

## 0. Gaps and Revisions From This Pass

**Carried over from the previous pass** (§0 of the prior version, kept
here for continuity): Composition Agent added (Gap 1), `validates`/
`invalidates` edges recommended for removal (Gap 2), `deprecation_reason`
columns added (Gap 3), `scoring_config` table added (Gap 4).

**New this pass:**

**Revision A — `owns:` added, refined from a blanket rule to
creation-rights + field-write grants.** A pure "owner writes, no one
else" rule was proposed and would have broken several already-correct
design decisions: `Confidence` writes `validation_score` onto a
Hypothesis it didn't create; `Scoring`, `FounderFit`, `Confidence`, and
`Compression` each write a distinct column on the same
`OpportunityCandidate` row created by `Composition`. **Resolved**:
`owns:` declares who has exclusive INSERT rights on a node type.
Column-level and status-transition-level write rights are declared
separately, per table, in §18's Field-Write Grants — narrower and more
enforceable than blanket table ownership, since it also stops an
owner from writing a field explicitly granted to someone else.

**Revision B — Validation Agent split into Collector and Evaluator.**
The prior Validation Agent both actively searched for evidence *and*
scored what it found — a hidden conflict of interest (an agent
grading its own search thoroughness). **Resolved**: `Validation`
(Collector, §6) only gathers `evidence_for`/`evidence_against`/
`missing_data`. A new `Confidence` Agent (Evaluator, §7) computes
`validation_score` (Hypothesis-level) and `confidence_score`/
`coverage`/`agreement`/`freshness` (Candidate-level, moved out of
Scoring Agent) from whatever Collector already gathered — it does not
itself search Data Pipeline.

**Gap 6 (newly surfaced): `business_model` had no declared creator.**
No agent in the prior roster explicitly wrote to `business_model`.
Resolved: `CompetitiveAnalysis` (§4) now also extracts competitors'
actual `business_model` rows (via `monetizes_via`) — the same
extractive-only constraint that already governed `existing_solution`
applies here, no new agent needed.

**`depends_on:` added to every agent** (Revision C), turning the
Orchestrator's previously-prose pipeline ordering (§12) into
structured data it can build an actual execution DAG from — see §17.

---

## 1. Discovery Agent

```
Agent: Discovery
owns: market
depends_on: []
input: normalized Data Pipeline records (source_type IN search_signal, marketplace, industry_report, financial_signal)
output: Market node data, unfiltered, high volume, low confidence threshold accepted
writes:
  - INSERT market (status='active')
  - INSERT node_source_refs (node_type='market')
reads:
  - Data Pipeline normalized records only
invariants:
  - MUST NOT write to any table except market, node_source_refs
  - MUST NOT set market.status to anything but 'active'
  - MUST NOT create a market row with zero node_source_refs rows
  - MUST NOT read audience, problem, existing_solution, business_model, hypothesis, opportunity_candidate, opportunity, outcome, founder, scoring_config, model_routing_config
  - MUST NOT rank, filter, or judge — structuring only
```

## 2. Expansion Agent

```
Agent: Expansion
owns: audience, problem
depends_on: [Discovery]
input: market WHERE status='active'; Data Pipeline audience/behavioral/review records
output: Audience and Problem node data; has_audience and experiences edges
writes:
  - INSERT audience (status='active')
  - INSERT problem (status='active')
  - INSERT edge (edge_type IN ('has_audience','experiences'))
  - INSERT node_source_refs (node_type IN ('audience','problem','edge'))
reads:
  - market WHERE status='active'
  - Data Pipeline normalized records
invariants:
  - problem.severity_signal and problem.frequency_signal MUST derive from an observable proxy in source text — MUST NOT be set from agent judgment
  - MUST NOT write to market, existing_solution, business_model, hypothesis, opportunity_candidate, opportunity, outcome, founder, scoring_config, model_routing_config
  - MUST NOT set status to 'deprecated' on any node (Filtering's exclusive right — see §18)
```

## 3. Filtering Agent

```
Agent: Filtering
owns: (none — this agent transitions status on nodes it does not create)
depends_on: [Expansion]
input: market, audience, problem WHERE status='active'; threshold config
output: same node set, deprecation applied per threshold rules
writes:
  - UPDATE market/audience/problem SET status='deprecated', deprecation_reason=<rule_id> WHERE below threshold
reads:
  - market, audience, problem WHERE status='active'
  - threshold configuration (static)
invariants:
  - Thresholds are configuration values read, never computed or adjusted by this agent
  - MUST NOT write to existing_solution, business_model, hypothesis, opportunity_candidate, opportunity, outcome, founder, scoring_config, model_routing_config
  - MUST NOT hard-delete any row — deprecation only
  - No LLM call permitted — deterministic rule evaluation only
  - This is one of exactly two agents permitted to write market/audience/problem.status — see §18 Field-Write Grants for the other (Memory, resurrection only)
```

## 4. Competitive Analysis Agent

```
Agent: CompetitiveAnalysis
owns: existing_solution, business_model
depends_on: [Filtering]
input: problem WHERE status='active'
output: ExistingSolution and BusinessModel node data; addressed_by, competes_with, monetizes_via edges
writes:
  - INSERT existing_solution (status='active')
  - INSERT business_model (status='active')   -- Gap 6 fix: previously undeclared
  - INSERT edge (edge_type IN ('addressed_by','competes_with','monetizes_via'))
  - INSERT node_source_refs (node_type IN ('existing_solution','business_model','edge'))
reads:
  - problem WHERE status='active'
  - Data Pipeline competitor-facing material records
invariants:
  - existing_solution.positioning_summary MUST be extractive from actual competitor-facing text — MUST NOT be inferred from category stereotypes
  - business_model rows MUST reflect a competitor's actual, stated monetization structure — MUST NOT invent a hypothetical business model for the eventual opportunity candidate; that reuse happens later, by Composition, selecting among these already-extracted rows
  - a positioning attribute not stated by the competitor is stored as NULL with lowered confidence — MUST NOT be inferred or back-filled
  - competitive set for a given Problem is scoped only to existing_solution rows reachable via that Problem's own addressed_by edges
  - MUST NOT write to market, audience, hypothesis, opportunity_candidate, opportunity, outcome, founder, scoring_config, model_routing_config
```

## 5. Hypothesis Agent

```
Agent: Hypothesis
owns: hypothesis
depends_on: [CompetitiveAnalysis]
input: problem × existing_solution subgraphs (via addressed_by edges), both status='active'
output: Hypothesis node data; hypothesis_sources rows
writes:
  - INSERT hypothesis (status='active', validation_score=NULL)
  - INSERT hypothesis_sources
  - INSERT node_source_refs (node_type='hypothesis', evidence_for)
  - UPDATE hypothesis SET missing_data (initial attempt — see §18, this field is co-writable with Validation Collector)
reads:
  - problem, existing_solution WHERE status='active'
  - evidence (filtered to verification_status != 'failed_verification' for llm_extraction sources)
invariants:
  - Bounded Synthesis Rule: evidence_for MUST cite at least 2 evidence rows with distinct cluster_id under their current cluster_version
  - MUST attempt evidence_against and missing_data in the same write; leaving evidence_against empty does not make the hypothesis complete — completeness is Validation Collector's (§6) responsibility to confirm, not this agent's to assume
  - hypothesis table and any future migration to it MUST NOT gain a solution-description-shaped column
  - MUST NOT write to market, audience, existing_solution, business_model, opportunity_candidate, opportunity, outcome, founder, scoring_config, model_routing_config
  - MUST NOT write validation_score, confidence_score, coverage, agreement, freshness (Confidence Agent's exclusive fields, §7, §18)
  - No other agent may perform the Bounded Synthesis operation
```

## 6. Validation Agent (Collector)

```
Agent: Validation
owns: (none — writes onto Hypothesis, which Hypothesis Agent owns; see §18)
depends_on: [Hypothesis]
input: hypothesis WHERE status='active'
output: additional evidence_for/evidence_against citations; missing_data; unresolved_questions
writes:
  - INSERT node_source_refs (node_type='hypothesis', newly found evidence_for and evidence_against)
  - UPDATE hypothesis SET missing_data (append — co-writable with Hypothesis Agent, §18)
reads:
  - hypothesis, evidence, node_source_refs
  - Data Pipeline (active querying for additional disconfirming evidence — not read-only against the existing store)
invariants:
  - MUST actively query Data Pipeline for disconfirming evidence per hypothesis, or log an explicit "no further sources available" result — an empty evidence_against with zero logged queries is rejected by the Orchestrator as incomplete
  - MUST NOT compute or write validation_score, confidence_score, coverage, agreement, or freshness — this is the entire point of the split from the prior single Validation Agent: the same agent that searches for evidence must not also be the one grading what it found
  - MUST NOT set hypothesis.status under any circumstance — status transitions on Hypothesis belong to Hypothesis Agent (initial 'active'), Confidence Agent (failed_validation), and Memory Agent (resurrection) only — see §18
  - MUST NOT write to market, audience, problem, existing_solution, business_model, opportunity_candidate, opportunity, outcome, founder, scoring_config, model_routing_config
```

## 7. Confidence Agent (Evaluator) — NEW

```
Agent: Confidence
owns: (none — writes scoring fields onto nodes owned by Hypothesis and Composition respectively; see §18)
depends_on: [Validation]                    # Mode 1 — Hypothesis-level
depends_on (Mode 2): [Scoring]                # Mode 2 — Candidate-level
input:
  Mode 1: hypothesis WHERE status='active' AND validation_score IS NULL, with its evidence_for/evidence_against/node_source_refs (as gathered by Hypothesis + Validation Collector)
  Mode 2: opportunity_candidate WHERE opportunity_quality IS NOT NULL AND confidence_score IS NULL, with its composed constituent nodes
output:
  Mode 1: hypothesis.validation_score; gate pass/fail
  Mode 2: opportunity_candidate.confidence_score, coverage, agreement, freshness
writes:
  Mode 1: UPDATE hypothesis SET validation_score, validation_computed_at_cluster_version
  Mode 1: UPDATE hypothesis SET status='deprecated', deprecation_reason='failed_validation' WHERE validation_score fails configured threshold
  Mode 2: UPDATE opportunity_candidate SET confidence_score, coverage, agreement, freshness
reads:
  Mode 1: hypothesis, evidence, node_source_refs
  Mode 2: opportunity_candidate, opportunity_candidate_composition and its composed rows
invariants:
  - MUST group evidence_for/evidence_against by (cluster_id, cluster_version) before weighting — raw per-row counting is not a valid implementation
  - within a cluster, weight MUST use the highest source_authority_tier present, not an average
  - MUST NOT perform its own Data Pipeline search — it scores only what Validation Collector (§6) and Hypothesis Agent (§5) already gathered; if evidence looks thin, that is reflected in a lower score, not a reason for this agent to go fetch more
  - MUST NOT write to market, audience, problem, existing_solution, business_model, opportunity, outcome, founder, scoring_config, model_routing_config
  - MUST NOT set hypothesis.status to 'active' after 'failed_validation' (resurrection is Memory's exclusive path) and MUST NOT set opportunity_candidate.status at all (Composition creates it, Compression transitions it — see §18)
  - This agent is the sole writer of validation_score and of confidence_score/coverage/agreement/freshness anywhere in the system — no other agent may write these four-plus-one fields under any circumstance
```

**Production prompt (V8, effective this commit)** — the Phase 5
prompt-variant bench (`apps/api/src/scripts/experimentConfidencePrompts.ts`)
settled on V8 after the active-search unblock (§6, Tavily
connector) put mechanism-specific evidence into `node_source_refs`.
V8 keeps V5's answer-the-question reformulation and banded scoring
(zero-answering [0.30, 0.65], some-answering [0.55, 0.90],
all-answering [0.75, 0.95]) but removes distinct-source counts
from the model's output schema entirely — those are computed
deterministically by `confidenceAgent.ts` and injected into the
prompt as GIVEN FACTS. Removing the count-reporting surface
eliminated the V3/V4/V7 semantic/mechanical field contamination
that broke earlier candidates. Repeatability at commit: 3/3
identical scores (0.72) on the reference 10-item pool, zero
bounded-rule violations. The two remaining bounded rules
(hallucinated evidence_id in per_evidence_answers_question,
score outside the band its own answers_question map implies) are
exercised by `confidenceSandbox.test.ts`.

## 8. Composition Agent

```
Agent: Composition
owns: opportunity_candidate
depends_on: [Confidence (Mode 1)]
input: hypothesis WHERE status='active' AND validation_score passes gate threshold; their linked market/audience/problem/business_model via existing edges
output: OpportunityCandidate node data; opportunity_candidate_composition rows (composes)
writes:
  - INSERT opportunity_candidate (status='candidate', opportunity_quality=NULL, founder_fit_score=NULL, venture_score=NULL, confidence_score=NULL)
  - INSERT opportunity_candidate_composition (exactly one row per role: market, audience, problem, hypothesis, business_model)
reads:
  - hypothesis WHERE status='active' AND validation passed
  - market, audience, problem, business_model WHERE status='active' (only those reachable via the hypothesis's existing edge chain)
invariants:
  - MUST NOT instantiate an opportunity_candidate unless all five roles resolve to an 'active' row
  - opportunity_candidate_composition PK is (candidate_id, role) — MUST NOT insert two rows for the same role on the same candidate
  - MUST NOT populate opportunity_quality, founder_fit_score, venture_score, confidence_score, coverage, agreement, or freshness — those belong to Scoring, FounderFit, Compression, and Confidence respectively
  - MUST NOT write to market, audience, problem, existing_solution, business_model, hypothesis, opportunity, outcome, founder, scoring_config, model_routing_config
```

**Semantics of the composed BusinessModel slot** (worth stating
explicitly to avoid a natural misread): the `business_model` role
on `opportunity_candidate_composition` is populated by walking
`hypothesis_sources → existing_solution → monetizes_via →
business_model`. The BusinessModel reached this way is one of the
**existing competitors'** models — not a proposed model authored
for the entrant. It is treated as a **competitive benchmark**: the
cost/margin/pricing/complexity structure a new entrant would be
competing *against*, not a plan the entrant would run.

**Why this framing, not "Composition synthesizes a proposed
BusinessModel"**: an LLM-synthesized proposed BM would be the
first evidence-ungrounded node in the graph. Every other node in
this pipeline is either evidence-cited (Market/Audience/Problem/
ExistingSolution/BusinessModel from Discovery/Expansion/
CompetitiveAnalysis, all with `node_source_refs` backing) or
bounded-verified (Hypothesis Agent's citations, Validation's
polarity classifications, Confidence's answers_question against
real evidence, FounderFit's grounded-match check). A proposed BM
would break that discipline — it would be a hallucination-risk
surface with no evidence to ground it against. Deliberately
rejected in favor of the "benchmark" framing.

Downstream agents interpret the composed BM under this framing:
Scoring's margin/feasibility sub-scores (§10) read the
competitor's fields as "market's margin structure the entrant is
benchmarked against" and "how hard the competitor's model is to
replicate, as a proxy for entry barrier." FounderFit's rationale
(§9) frames capital/complexity gaps as "would need to compete
against this BM with the founder's capital," not "would run this
BM." Both are prompt-language responsibilities, not formula
changes.

## 9. Founder Fit Agent

```
Agent: FounderFit
owns: (none — writes two fields onto Composition-owned OpportunityCandidate; see §18)
depends_on: [Scoring]
input: founder (single row, scoped to the run's user); opportunity_candidate WHERE status='candidate' AND opportunity_quality IS NOT NULL
output: founder_fit_score, founder_fit_rationale per candidate; fits/does_not_fit edges
writes:
  - UPDATE opportunity_candidate SET founder_fit_score, founder_fit_rationale
  - INSERT edge (edge_type IN ('fits','does_not_fit'), from=founder.id, to=opportunity_candidate.id)
reads:
  - founder (single row for this run)
  - opportunity_candidate, and its composed business_model/market rows (via opportunity_candidate_composition)
invariants:
  - MUST NOT modify opportunity_quality, venture_score, confidence_score, coverage, agreement, freshness — not this agent's fields
  - MUST NOT write to market, audience, problem, existing_solution, business_model, hypothesis, opportunity, outcome, scoring_config, model_routing_config
  - MUST NOT write to founder (read-only)
```

## 10. Scoring Agent

```
Agent: Scoring
owns: (none — writes one field onto Composition-owned OpportunityCandidate; see §18)
depends_on: [Composition]
input: opportunity_candidate WHERE status='candidate' AND all 5 composition rows present
output: opportunity_quality per candidate (confidence_score/coverage/agreement/freshness moved to Confidence Agent, §7)
writes:
  - UPDATE opportunity_candidate SET opportunity_quality
reads:
  - opportunity_candidate_composition (to resolve the 5 constituent rows)
  - market, audience, problem, hypothesis, business_model (the composed rows only)
  - scoring_config (read-only — current w1..w6 and vertical profile)
invariants:
  - MUST invoke the Decision Engine's compute_venture_score interface as a deterministic function call
  - MUST read scoring_config at run start and use a frozen snapshot for the duration of this candidate's scoring
  - MUST NOT set founder_fit_score, venture_score, confidence_score, coverage, agreement, or freshness
  - MUST NOT write to market, audience, problem, existing_solution, business_model, hypothesis, opportunity, outcome, founder, model_routing_config
```

## 11. Compression Agent

```
Agent: Compression
owns: opportunity
depends_on: [FounderFit, Confidence (Mode 2)]
input: opportunity_candidate WHERE status='candidate' AND opportunity_quality, founder_fit_score, confidence_score all NOT NULL
output: venture_score per candidate; exactly one promoted Opportunity node
writes:
  - UPDATE opportunity_candidate SET venture_score (gate + weighted formula, v3 §8)
  - UPDATE opportunity_candidate SET status='deprecated', deprecation_reason IN ('lost_tiebreak','failed_gate') for all non-winners
  - UPDATE opportunity_candidate SET status='promoted' for the winner
  - INSERT opportunity (via the promotion transaction, DATABASE_SCHEMA.md §8)
  - INSERT edge (edge_type='promotes', from=winning candidate, to=new opportunity)
  - UPDATE opportunity SET status='superseded' + INSERT edge (edge_type='supersedes') for any prior active Opportunity sharing constituent lineage — same transaction
reads:
  - opportunity_candidate (all candidates for this run)
  - opportunity WHERE status='active' (lineage overlap check)
invariants:
  - MUST apply the fixed tie-break sequence exactly (venture_score → margin → confidence_score → founder_fit_score → distribution_score → recency → complexity) — no discretionary override
  - MUST perform promotion as a single transaction — partial writes are a hard failure
  - MUST produce exactly one 'promotes' edge per successful run
  - venture_score formula is gate-plus-weighted-sum (v3 §8) — NOT multiplicative (see §17 rejection log)
  - MUST NOT write to market, audience, problem, existing_solution, business_model, hypothesis, founder, outcome, scoring_config, model_routing_config
  - Sole agent permitted to write opportunity_candidate.venture_score and .status, and the only agent permitted to create or modify opportunity at all
```

## 12. Memory Agent

```
Agent: Memory
owns: (none — a cross-cutting agent that transitions lifecycle state on nodes owned by others, and is sole writer of two config tables; see §18)
depends_on: []                              # not part of the per-run DAG at all — scheduled batch only, never triggered by a live run
input: outcome rows (new since last cycle); full node/edge set for resurrection matching; scoring_config and model_routing_config (current)
output: updated lifecycle states (resurrection_candidate transitions); new scoring_config/model_routing_config versions
writes:
  - UPDATE market/audience/problem/existing_solution/business_model/hypothesis SET status='resurrection_candidate' WHERE confidence crosses configured delta above deprecation-time value
  - UPDATE evidence SET cluster_id, cluster_version (Reclustering)
  - INSERT scoring_config (new row, new version — never UPDATE)
  - INSERT model_routing_config (new row, new version — never UPDATE)
reads:
  - outcome (all, append-only — read-only, never writes here)
  - all structural node tables, for resurrection candidacy checks
  - evidence, for Reclustering
invariants:
  - Weight tuning and Reclustering both run on a scheduled batch cadence only — MUST NOT trigger either synchronously inside a live pipeline run
  - Weight adjustments are bounded per cycle (no single weight shifts by more than 0.05)
  - MUST NOT write to opportunity_candidate, opportunity directly
  - MUST NOT mutate outcome rows (append-only, DB-trigger-enforced)
  - This is the only agent permitted to write status='resurrection_candidate' on any structural node type, including hypothesis — see §18
  - Sole writer of scoring_config and model_routing_config in the entire roster
```

## 13. Orchestrator

```
Agent: Orchestrator
owns: (none — coordinates, does not create graph nodes)
depends_on: [all 12 agents above, transitively — this agent executes the DAG they collectively declare, see §17]
input: pipeline run trigger; every other agent's output before it reaches the graph
output: sequencing decisions; accept/reject per handoff
writes:
  - none directly to node/edge tables — writes only pipeline run metadata (run_id, stage, status) [pipeline_run table not yet specified — flagged, see note below]
reads:
  - every agent's proposed output, pre-commit, for schema validation
  - every agent's depends_on declaration, to construct the execution DAG (§17)
invariants:
  - MUST reject any agent output missing required node_source_refs before it is written to the graph
  - MUST build and execute the DAG from declared depends_on values — an agent MUST NOT run before all agents in its depends_on list have completed for that run
  - MUST enforce "no partial output" — if the pipeline fails before Compression, the run ends in an explicit failure/insufficient-evidence state
  - MUST reject any non-Hypothesis-Agent output that attempts the Bounded Synthesis operation
  - MUST verify exactly one 'promotes' edge exists at end of a successful run before marking the run complete
  - MUST enforce every Field-Write Grant in §18 — an agent's proposed write to a column not granted to it is rejected before it reaches the graph, identically to a missing-source_refs rejection
```

**Note on Orchestrator's own storage**: `pipeline_run` table remains
an open gap from the prior pass, not resolved here.

---

## 14. Schema Patches Required (corrected — prior pointer was dangling)

The `deprecation_reason` columns and `scoring_config`/
`model_routing_config` tables this section used to describe by
pointing at "the prior version's §13 SQL" no longer had anywhere to
point — that content was dropped during the v1→v2 rewrite and never
carried into DATABASE_SCHEMA.md. Found and fixed while assembling the
first real migration file: all of it now lives directly in
DATABASE_SCHEMA.md §3 (node tables 3.2–3.7 for `deprecation_reason`,
3.12–3.13 for the two config tables) — that document is the sole
source of DDL from here on; this file no longer carries a duplicate
copy to avoid the same drift happening twice.

---

## 15. Write Scope Matrix (every agent × every table)

`W` = writes, `R` = reads, blank = no access.

| Table | Disc | Exp | Filt | CompAn | Hyp | ValC | Conf | Comp* | FFit | Score | Compr | Mem |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| market | W | R | W/R | | | | | R | | R | | R |
| audience | | W | W/R | | | | | R | | R | | R |
| problem | | W | W/R | R | R | | | R | | R | | R |
| existing_solution | | | | W | R | | | | | | | R |
| business_model | | | | W | | | | R | | R | | R |
| hypothesis | | | | | W | W†/R | W/R | R | | | | R |
| evidence | | | | | R | R | R | | | | | W/R |
| node_source_refs | W | W | | W | W | W | | | | | | |
| founder | | | | | | | | | R | | | |
| opportunity_candidate | | | | | | | | W | W/R | W/R | W/R | |
| opportunity_candidate_composition | | | | | | | R | W | R | R | R | |
| opportunity | | | | | | | | | | | W/R | R |
| outcome | | | | | | | | | | | | R |
| scoring_config | | | | | | | | | | R | | W |
| model_routing_config | | | | | | | | | | | | W |

*Composition Agent. †`missing_data` only, co-written with Hypothesis Agent — see §18.

---

## 16. Model Routing (NVIDIA NIM endpoints) — carried over, updated for 13-agent roster

**Revision (post-Phase-4 empirical finding)**: Expansion moved from
low-cost to mid-tier. The original low-cost placement treated
Discovery/Expansion/CompetitiveAnalysis as uniformly "extractive," but
this was inconsistent with this project's own stated central bet
(symptom ≠ cause) — Expansion, not Discovery, is where that reasoning
first has to happen (VERTICAL_BASELINE.md §6, the Shop Pay example).
A live Phase 4 run against an 8B-class low-cost-tier model confirmed
this empirically: all three Problem labels it produced were surface
restatements or mechanical links, never the causal/consequence framing
("involuntary churn disguised as voluntary, no merchant tooling
distinguishes the two") the fixture was built to elicit. This is
exactly the risk MVP_IMPLEMENTATION_PLAN.md §4 risk 1 anticipated,
now confirmed rather than hypothetical.

| Agent | LLM needed? | Tier |
|---|---|---|
| Discovery | yes — extraction | low-cost |
| Expansion | yes — causal/consequence reasoning, not pure extraction | **mid-tier** (moved from low-cost — see revision note above) |
| Filtering | no | — |
| CompetitiveAnalysis | yes — extractive summarization | low-cost |
| Hypothesis | yes — bounded synthesis | mid-tier |
| Validation (Collector) | yes — targeted adversarial search | mid-tier |
| Confidence (Evaluator) | yes — weighing/aggregation reasoning | mid-tier |
| Composition | no | — |
| FounderFit | yes — comparative reasoning | mid-tier |
| Scoring | no | — |
| Compression | no for tie-break; optional for phrasing | mid-tier (phrasing only) |
| Memory | no (embedding endpoint for Reclustering only) | — |
| Orchestrator | no | — |

`model_routing_config` schema unchanged from prior pass — one row per
agent per version, Memory Agent is sole writer.

---

## 17. Execution DAG (resolves architect review point 3)

The `depends_on:` field on every agent above is the actual dependency
data. The DAG it forms:

```
Discovery
  → Expansion
    → Filtering
      → CompetitiveAnalysis
        → Hypothesis
          → Validation (Collector)
            → Confidence [Mode 1: Hypothesis]
              → Composition
                → Scoring
                  → Confidence [Mode 2: Candidate]
                  → FounderFit
                    → Compression

Memory: not part of this DAG — scheduled batch, independent of any run
```

Note `Confidence [Mode 2]` and `FounderFit` both depend only on
`Scoring` and can run in parallel; `Compression` depends on both
completing. This is the one place in the DAG with genuine parallelism
— everything else is a strict chain. The Orchestrator (§13) is
responsible for recognizing this and executing the two branches
concurrently rather than serializing them unnecessarily.

**This DAG is executed by our own Orchestrator code, not by NVIDIA
Build/NIM** — consistent with the scope decision already made (models
via NIM endpoints; orchestration stays ours). NIM has no visibility
into `depends_on` and no role in sequencing.

---

## 18. Ownership Model and Field-Write Grants (resolves architect review point 1)

**Rule**: `owns:` (declared per-agent above) grants exclusive INSERT
rights on that node type. It does **not** by itself grant update
rights on every field — those are granted individually below, per
table, and an agent may only write a field or status-transition it is
explicitly listed against. This is deliberately stricter than a
blanket "owner may write, no one else may" rule: it also prevents an
*owner* from writing a field that's been explicitly delegated
elsewhere.

### 18.1 Single-writer tables (owns = full write rights)

`market`, `audience`, `problem` (creation: Expansion/Discovery per
§1–§2; `status`/`deprecation_reason`: **Filtering** for
active→deprecated, **Memory** for deprecated→resurrection_candidate→
active — no other agent may write status on these three tables).

`existing_solution`, `business_model` (creation and all fields:
**CompetitiveAnalysis** exclusively; no deprecation path currently
defined for these two — flagged as a minor open item, not resolved
here, since neither v1 nor this pass specified Filtering-equivalent
pruning for competitor-derived nodes).

### 18.2 Hypothesis — multi-writer, field-level grants

| Field(s) | Writer |
|---|---|
| statement, gap_type, evidence_for (initial), supporting_evidence_strength | Hypothesis Agent (creation only) |
| missing_data | Hypothesis Agent (initial) AND Validation Collector (append) — the only two-writer field in the schema, deliberately, since both legitimately discover unknowns at different points |
| evidence_against (further citations) | Validation Collector only |
| validation_score, validation_computed_at_cluster_version | Confidence Agent only |
| status = 'active' | Hypothesis Agent only (on creation) |
| status = 'deprecated', deprecation_reason = 'failed_validation' | Confidence Agent only |
| status = 'resurrection_candidate' / back to 'active' via resurrection | Memory Agent only |

No agent other than those named above may write any field on
`hypothesis` — in particular, Composition and Scoring, which both
*read* hypothesis rows, may not write to them at all.

### 18.3 OpportunityCandidate — multi-writer, field-level grants

| Field(s) | Writer |
|---|---|
| creation, all NULL scoring fields at insert | Composition Agent only |
| opportunity_quality | Scoring Agent only |
| founder_fit_score, founder_fit_rationale | FounderFit Agent only |
| confidence_score, coverage, agreement, freshness | Confidence Agent only |
| venture_score | Compression Agent only |
| status, deprecation_reason | Compression Agent only (candidate → deprecated/promoted) |

Composition creates the row but does not touch it again after
creation — every subsequent field is owned by a different, single,
named agent. This table is the clearest illustration of why blanket
table-level ownership would have been wrong: five different agents
legitimately write to it, each to exactly one non-overlapping set of
columns.

### 18.4 Opportunity — single writer throughout

Compression Agent creates it, and Compression Agent is also the only
agent that ever transitions its `status` (active → superseded, on a
later run's promotion). No field-level grant table needed — this is
the one node type where "owns" and "sole writer of every field"
coincide exactly.

---

## 19. Summary

Thirteen agents. Composition (added in the prior pass) and Confidence
(added in this pass, split out of the prior single Validation Agent)
are the two additions to the original nine. Every agent contract now
declares `owns` and `depends_on` in addition to the original five
fields, and every multi-writer table has an explicit field-level grant
table (§18) rather than relying on the Write Scope Matrix (§15) alone
to imply who may touch what. The Orchestrator (§13, §17) executes a
real dependency DAG built from declared data, not prose ordering
rules. `validates`/`invalidates` edges remain flagged for removal
(carried over, unresolved). A `pipeline_run` table for the
Orchestrator's own bookkeeping remains an open gap.

---

## 20. Explicitly Rejected From the NVIDIA-Framed Draft (carried over, unchanged)

1. Multiplicative Decision Formula — rejected, gate+weighted-sum stands (v3 §8, Compression Agent §11).
2. Ingestion as agent-owned reads of external sources — rejected, Data Pipeline stays a separate non-agent subsystem; Discovery/Expansion/CompetitiveAnalysis consume pre-normalized records only.
