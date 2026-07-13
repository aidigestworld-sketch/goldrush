# Opportunity Engine — Graph Schema Specification
## (Node Schemas, Edge Schemas, Lifecycle Rules)

---

## 0. Purpose and Sequencing Rationale

DB, Agents, and Pipeline are all correctly held as unstable until this
layer locks. Every agent (v3 §5) is defined in terms of what it reads
and writes on the graph; every pipeline handoff (v1 AI_AGENTS §5) is a
schema-validated handoff. If node/edge schemas or lifecycle rules move
after agents are built against them, every downstream component needs
rework. This document is the dependency root: nothing else should be
implemented against a schema that isn't locked here first.

**Node type count note**: this spec covers **11** node types, not 10.
`Evidence` was elevated to a first-class graph node in the previous
iteration (v3 §2.1) specifically so Weighted Evidence Validation could
traverse it. If the intent is to keep Evidence as a Data-Pipeline-level
record rather than a graph node (reverting to v1's original model,
where only `source_refs` pointers existed), that changes §2.1, §3, and
part of §4 below — flag it and I'll cut it back to 10 before this
locks. Everything below assumes 11 until told otherwise.

Scope: this document defines **structure and legal state**, not
behavior. Which agent writes which field is AI_AGENTS.md's job (v3
§5); this document only defines what a valid node/edge/state looks
like, so that agent work has a fixed target.

---

## 1. Base Schema (inherited by all 11 node types)

```yaml
BaseNode:
  id: string                 # unique, immutable once assigned
  type: enum                 # one of the 11 types below — immutable
  label: string              # human-readable
  created_at: timestamp      # immutable
  last_seen_at: timestamp    # updated on any write touching this node
  source_refs: [string]      # Evidence node ids (see §2.1) or Data Pipeline record ids this node traces to
  status: enum               # legal values differ per type — see §4
  confidence: float [0-1]    # for most types; superseded by composite confidence_score on Hypothesis/OpportunityCandidate — see §2.7/§2.9
```

**Invariant (all types)**: a node cannot be created with an empty
`source_refs` array unless its type is explicitly exempt (only
`Founder` and `Outcome` are exempt — see their sections). This is the
graph-level enforcement of Principle 5 (Evidence over Opinion).

---

## 2. Node Schemas

### 2.1 Evidence

```yaml
Evidence:
  # + BaseNode fields, with source_refs N/A (Evidence IS the leaf of the source_refs chain)
  source_url_or_identifier: string
  source_type: enum            # search_signal | marketplace | review_complaint | competitor_material | industry_report | financial_signal — v1 DATA_PIPELINE §3
  source_authority_tier: enum  # industry_report > competitor_self_stated > review_verified > forum_post > anonymous_comment
  cluster_id: string          # nodes sharing this id (within the same cluster_version) are treated as one weighted vote, not N — v3 §5.2
  cluster_version: integer    # which Reclustering run (§4.13) produced this cluster_id — mutable, see §4.13
  extraction_method: enum       # structured_api | html_parse | llm_extraction — v1 DATA_PIPELINE §5
  extraction_confidence: float [0-1]
  extracted_fact: string
  fetched_at: timestamp
  freshness: float [0-1]        # decays per v1 DATA_PIPELINE §9
  verification_status: enum     # unverified | verified | failed_verification — v1 DATA_PIPELINE §6, applies only to llm_extraction records
```

**Invariant**: `verification_status` must be `verified` before an
Evidence node backed by `llm_extraction` can be cited in
`evidence_for`/`evidence_against` on a Hypothesis (§2.6). Structured-
API evidence skips this gate (v1 DATA_PIPELINE §6 — no LLM involved,
schema/type validation only).

### 2.2 Market

```yaml
Market:
  # + BaseNode
  market_size_estimate: number
  growth_rate_estimate: float
  maturity_stage: enum          # emerging | growing | mature | declining
  parent_market_id: string | null
  category_tags: [string]
```

**Invariant**: `parent_market_id`, if set, must reference an existing
`Market` node — enforces the sub-market hierarchy (v1 §3.2) as a real
graph constraint, not just a convention.

### 2.3 Audience

```yaml
Audience:
  # + BaseNode
  demographic_profile: object
  behavioral_profile: object
  size_estimate: number
  willingness_to_pay_signal: float
  acquisition_channels_known: [string]
```

### 2.4 Problem

```yaml
Problem:
  # + BaseNode
  severity_signal: float          # must derive from an observable proxy, never agent judgment — v1 AI_AGENTS §4.2
  frequency_signal: float
  current_workaround_description: string
  problem_maturity: enum          # unrecognized | recognized_unsolved | partially_solved
```

### 2.5 Existing Solution (Competitor)

```yaml
ExistingSolution:
  # + BaseNode
  positioning_summary: string       # extractive only, no inference — v1 COMPETITIVE_INTELLIGENCE §4
  pricing_model: object
  estimated_market_share: float | null
  strengths: [string]
  weaknesses: [string]
  distribution_channels: [string]
```

**Invariant**: any field left un-extractable from source text (v1
COMPETITIVE_INTELLIGENCE §4.3) is stored as `null` with a lowered
`confidence`, never inferred or back-filled.

### 2.6 Business Model

```yaml
BusinessModel:
  # + BaseNode
  model_type: enum          # one_time | subscription | marketplace_take_rate | service | hybrid
  margin_profile: float
  operational_complexity_estimate: float
  capital_intensity_estimate: float
```

### 2.7 Hypothesis (renamed/reframed from White Space, v3 §2.2)

```yaml
Hypothesis:
  # + BaseNode
  statement: string
  gap_type: enum                  # positioning | pricing | business_model | distribution
  evidence_for: [evidence_id]
  evidence_against: [evidence_id]
  missing_data: [string]
  supporting_evidence_strength: float
  validation_score: float | null   # null until Validation Agent runs — v3 §5.2
```

**Invariant**: no `solution_description` field exists anywhere in
this schema, and none may be added — this is the structural guardrail
(v1 AI_AGENTS §7) that makes solution-proposal by this node type
unrepresentable, not just discouraged. Any future schema change adding
such a field is itself a Principle 8 violation and must be rejected at
schema-review, not just at runtime.

### 2.8 Founder

```yaml
Founder:
  id: string
  type: founder
  expertise: [string]
  industries: [string]
  geography: string
  capital_availability: enum | number
  distribution_assets: [string]
  audience_assets: [string]
  team_size: integer
  constraints: [string]
  created_at: timestamp
  last_updated_at: timestamp
  # NOTE: no source_refs, no confidence, no status —
  # exempt from the base-schema invariant (§1). Rationale: a Founder
  # node is self-declared by the user, not evidence-derived from
  # external sources. It is versioned by last_updated_at, not by a
  # lifecycle state machine — see §4.8.
```

### 2.9 OpportunityCandidate (v3 §2.4)

```yaml
OpportunityCandidate:
  id: string
  type: opportunity_candidate
  constituent_node_ids: [string]   # full composes chain: Market, Audience, Problem, Hypothesis, BusinessModel — all required, no partial chains (v1 §10)
  opportunity_quality: float        # six-component weighted sum, v1 DECISION_ENGINE §4
  founder_fit_score: float | null   # null until Founder Fit Agent runs
  founder_fit_rationale: string | null
  venture_score: float | null       # null until §8 formula applied (needs founder_fit_score)
  confidence_score: float
  coverage: float                   # v3 §6 composite components
  agreement: float
  freshness: float
  status: enum                      # candidate | deprecated | promoted — see §4.9
  created_at: timestamp
  last_seen_at: timestamp
```

**Invariant**: `constituent_node_ids` must resolve to exactly one
Market, one Audience, one Problem, one Hypothesis, and one
BusinessModel node, all `status: active` at time of composition — an
incomplete chain cannot be scored (v1 §10, carried forward).

### 2.10 Opportunity (v3 §2.4, terminal node)

```yaml
Opportunity:
  id: string
  type: opportunity
  promoted_from_candidate_id: string   # required, always exactly one
  venture_score: float                  # copied at promotion, not recomputed
  confidence_score: float
  founder_fit_score: float
  founder_fit_rationale: string
  rationale_bullets: [string]
  risk_summary: [string]
  constituent_node_ids: [string]         # copied from the promoted candidate
  status: enum                            # active | superseded — see §4.10
  created_at: timestamp
```

**Invariant**: this node type can only be created by the `promotes`
edge write path (Compression Agent, v3 §5.4) — no other agent may
create an `Opportunity` node directly. This is the schema-level
enforcement of "exactly one output" (Principle 6).

### 2.11 Outcome (v3 §2.5)

```yaml
Outcome:
  id: string
  type: outcome
  opportunity_id: string       # must reference an Opportunity node (§2.10), never a Candidate
  signal_type: enum             # building_this | rejected | re_ran | self_reported | no_signal
  signal_strength: enum          # strong | medium | weak_negative | neutral
  reason_tag: string | null
  reported_at: timestamp
  confidence: float               # self-reported outcomes get a distinctly lower default — v1 §5.2
  # NOTE: no source_refs, no status field — an Outcome is an
  # immutable, append-only record of what happened. It is never
  # edited or deprecated after creation; a changed user reaction
  # creates a new Outcome node, not a mutation of the old one.
```

---

## 3. Edge Schemas

```yaml
BaseEdge:
  from_id: string
  to_id: string
  type: enum            # one of the types below
  confidence: float [0-1]
  source_refs: [evidence_id]   # required unless the edge type is explicitly exempt (see table)
  created_at: timestamp
```

| Edge Type | From → To | Cardinality | source_refs required? | Notes |
|---|---|---|---|---|
| `contains` | Market → Market | 1:N | yes | sub-market hierarchy |
| `has_audience` | Market → Audience | N:M | yes | |
| `experiences` | Audience → Problem | N:M | yes | |
| `addressed_by` | Problem → ExistingSolution | N:M | yes | |
| `competes_with` | ExistingSolution → ExistingSolution | N:M | yes | |
| `monetizes_via` | ExistingSolution → BusinessModel | N:1 | yes | |
| `reveals` | (Problem, ExistingSolution set) → Hypothesis | N:1 | yes | hyperedge in practice — modeled as multiple `reveals` edges sharing one `hypothesis_id` |
| `supports` | Evidence → Hypothesis | N:M | **no** *(the edge itself IS the source reference — requiring source_refs on it would be circular)* | |
| `contradicts` | Evidence → Hypothesis | N:M | no *(same reason)* | |
| `co_clustered_with` | Evidence → Evidence | N:M, symmetric | no | derived/computed edge, not evidence-backed itself; implicitly scoped to a `cluster_version` (§4.13) — an edge from an older reclustering run is not automatically valid under a newer one and is recomputed, not carried forward |
| `composes` | (Market, Audience, Problem, Hypothesis, BusinessModel) → OpportunityCandidate | 5:1 (hyperedge, 5 required legs) | yes | all 5 legs required — partial composition is invalid, not low-confidence |
| `fits` | Founder → OpportunityCandidate | 1:N | no *(Founder has no source_refs — self-declared, see §2.8)* | |
| `does_not_fit` | Founder → OpportunityCandidate | 1:N | no | |
| `promotes` | OpportunityCandidate → Opportunity | 1:1, exactly one per successful run | yes | only Compression Agent writes this edge |
| `supersedes` | Opportunity → Opportunity | 1:1 or 1:0 | yes | only between terminal nodes, never Candidates |
| `resolves` | Outcome → Opportunity | N:1 | no *(Outcome is self-reported/behavioral, not evidence-derived)* | |

*(`validates`/`invalidates` edges from earlier drafts have been
removed — AI_AGENTS.md §19/§20 found no valid origin node type for
them among the 11 node types; `hypothesis.validation_score` and
`hypothesis.status` already carry everything those edges were meant
to convey.)*

**Cross-cutting invariant**: an edge cannot be created if either
endpoint is missing or has `status` outside the set of legal
"writable" states for that edge type at that lifecycle stage (e.g.
`promotes` cannot target an `OpportunityCandidate` with
`status: deprecated` — only `status: candidate` at the moment of
Compression). Enforced by the Orchestrator, same mechanism as v1
AI_AGENTS §4.9.

---

## 4. Lifecycle Rules

General pattern inherited from v1 (OPPORTUNITY_GRAPH §6, §8): nodes
are never hard-deleted. Every transition below is a `status` change
with a reason attached, retained for audit and resurrection.

### 4.1–4.6 Evidence-derived structural nodes (Market, Audience, Problem, ExistingSolution, BusinessModel) — shared lifecycle

```
active
  → deprecated          (Filtering Agent prunes below threshold, v1 AI_AGENTS §4.3; reason attached)
    → archived           (deprecated across N consecutive runs with no confidence change — storage tier only, still queryable)
      → resurrection_candidate   (new source_refs push confidence above resurrection threshold)
        → active                 (re-enters current run's graph)
  → merged              (Memory's node-matching, v1 §7, merges a new observation into this node instead of creating a duplicate)
```

**Invariant**: `deprecated`/`archived`/`merged` nodes are excluded
from active scoring by default but remain traversable via the
Evidence Layer. A `merged` node's `id` is retained as an alias so
historical edges pointing at it remain resolvable.

**Invariant (merge provenance, added per AGENT_EXECUTION_DAG.md §7)**:
when two nodes are merged, every `node_source_refs` row pointing at
the losing node is re-pointed to the surviving node **additively** —
the surviving node's evidence set becomes the union of what both nodes
cited, never just the survivor's original set with the other
discarded. A merge that drops either side's provenance is a bug, not
an acceptable simplification — this is precisely the kind of loss that
stays invisible until someone needs to audit why a node has the
confidence it has.

### 4.7 Hypothesis

```
active
  → deprecated (failed_validation)   (Validation Agent's validation_score fails to clear threshold, v3 §5.2)
  → deprecated (pruned)               (superseded by Filtering-equivalent logic if evidence base weakens)
    → archived → resurrection_candidate → active   (same pattern as §4.1, triggered by new evidence_for/evidence_against added post-deprecation)
  → merged                            (two Hypotheses found to describe the same underlying gap, via node-matching)
```

**Invariant**: a Hypothesis can never transition directly from
`active` to a state implying it became a solution or product — no
such transition exists in this state machine, mirroring the schema-
level guardrail in §2.7. The `merged` transition follows the same
provenance-union rule as §4.1–4.6 — `evidence_for`/`evidence_against`
citations from both Hypotheses survive on the merged node, never just
one side's.

### 4.8 Founder

```
active (only state)
  — updated in place via last_updated_at on any field change
  — no deprecation, archival, or merge transitions
```

**Rationale**: a Founder profile is a live, user-owned record, not an
evidence-derived hypothesis about the world. If multi-founder/team
accounts are ever supported (flagged out-of-scope in v1
OPPORTUNITY_MEMORY §10), this section will need a `merged` state for
combining individual profiles — explicitly not designed here.

### 4.9 OpportunityCandidate

```
candidate                          (created via composes edge, all 5 legs present)
  → deprecated (lost_tiebreak)      (Compression Agent, not selected — v3 §7)
  → deprecated (failed_gate)        (founder_fit_score below minimum_fit_threshold, v3 §8 — excluded before scoring)
  → deprecated (incomplete_chain)   (composes chain broken by an upstream node deprecation — v1 §10 rule)
  → promoted                        (Compression Agent selects this candidate; triggers promotes edge + new Opportunity node — terminal, no further transitions for this candidate)
```

**Invariant**: `promoted` is terminal — a promoted candidate is never
re-evaluated or resurrected; if the underlying situation changes,
Memory expresses that via a *new* run producing a new candidate and,
if selected, a `supersedes` edge between the two `Opportunity` nodes
(§4.10), not by mutating the old candidate.

### 4.10 Opportunity

```
active                              (created via promotes edge — exactly one per successful run)
  → superseded                       (a later run's promoted Opportunity is linked to this one via a supersedes edge)
```

**Invariant**: at most one `Opportunity` node per user should be
`active` for a given constituent-node lineage at any time — a new
promotion for an overlapping lineage must create a `supersedes` edge
and flip the prior node to `superseded`, not leave two `active`
Opportunity nodes implying two simultaneous "the" recommendations
(would violate Principle 6 at the memory layer).

### 4.11 Outcome

```
recorded (only state — immutable, append-only)
```

No transitions. A changed user reaction after the fact (e.g. "building
this" later becomes "abandoned") is captured as a **new** Outcome node
with a later `reported_at`, not an edit to the earlier one — this
preserves the actual history of signal over time for Memory tuning
(v3 §9), rather than overwriting it.

### 4.12 Evidence

```
active
  → stale        (Data Pipeline flags source unavailable or freshness decays past threshold — v1 DATA_PIPELINE §9)
  → superseded    (a newer fetch of the same source_url_or_identifier replaces this record; old one retained for audit)
```

`verification_status` (unverified/verified/failed_verification, §2.1)
is a separate axis from `status` — an Evidence node can be `active`
and `failed_verification` simultaneously, which is precisely the
signal that excludes it from citation (§2.1 invariant) without
deprecating the record itself (the raw fetch is still worth keeping
for audit of what the extractor got wrong).

### 4.13 Reclustering (replaces the "assigned once, never reassigned" rule)

The prior version of this spec fixed `independence_cluster_id` at
ingestion and forbade reassignment, specifically to avoid invalidating
already-computed `validation_score`/`Agreement` values. That rule is
now replaced with a versioned model, because clustering quality will
improve as the graph grows (better embeddings, more evidence density
to cluster against) and a permanently-frozen assignment would force a
full data migration to ever benefit from that improvement.

**Reclustering is a scheduled or explicitly-triggered batch process**
(same cadence philosophy as Memory Agent's weight tuning, v3 §4.8 —
never mid-run, never silently inside a live pipeline pass):

```
Reclustering run N:
  increments cluster_version → N
  recomputes cluster_id for some or all Evidence nodes under the new version
  writes new (cluster_id, cluster_version) onto each affected Evidence node
    — this is a mutation of the Evidence node's current cluster fields,
      not a new Evidence node
  recomputes co_clustered_with edges under version N
    — edges from version N-1 are not carried forward or assumed valid
```

**Why this does not require a migration of historical scores**:
`validation_score` (Hypothesis, §2.7) and `confidence_score` /
`Agreement` (OpportunityCandidate, §2.9 / §6) are *stored, computed-
once values* on their own nodes — they are not live queries against
Evidence at read time. A Reclustering run changes what a *future*
computation would produce; it does not retroactively alter a value
already written to a Hypothesis or OpportunityCandidate node. Those
only change when that specific node is genuinely re-validated
(triggered by new evidence attachment, the resurrection path in §4.7,
or an explicit Memory Agent request) — and when that happens, it
naturally picks up the then-current `cluster_version`.

**Traceability recommendation (flagged, not yet a required field)**:
consider whether a stored `validation_score` should carry the
`cluster_version` it was computed under, so it's later inspectable
whether a given score predates a clustering improvement. Not added as
a required field here to avoid scope creep beyond what was asked —
flagging it the same way §13 in the v3 architecture doc flags
deferred-but-not-forgotten items.

---

## 5. Cross-Cutting Schema Invariants (Orchestrator-enforced)

- No node of any type is created without passing base-schema
  validation (§1) — enforced identically to v1 AI_AGENTS §4.9/§9.
- No `Opportunity` node exists without a `promotes` edge from exactly
  one `OpportunityCandidate` (§2.10, §3).
- No `OpportunityCandidate` is scored (`venture_score` populated)
  without a complete 5-leg `composes` chain, all legs `active` (§2.9).
- No Hypothesis can carry a `solution_description`-shaped field, now
  or in any future schema revision (§2.7) — this is a standing
  constraint on schema changes themselves, not just runtime data.
- `Evidence.cluster_id`/`cluster_version` is versioned and mutable via
  Reclustering (§4.13) — reassignment is expected over time, not
  forbidden. What must not happen is a Reclustering run mutating a
  Hypothesis's or OpportunityCandidate's already-stored
  `validation_score`/`confidence_score`/`Agreement` in place; those
  only change through genuine re-validation of that specific node.
- Outcome nodes are never mutated or deleted after creation (§4.11) —
  the only lifecycle-free node type in the graph, by design.

---

## 6. What This Document Does Not Cover

- Agent read/write responsibilities per node type — that's AI_AGENTS.md (v3 §5), unchanged, now targeting these locked schemas.
- Scoring formulas (`venture_score`, `validation_score` mechanics) — DECISION_ENGINE.md (v3 §8) and §5.2, unchanged, now targeting these locked schemas.
- Physical database implementation (which graph DB, indexing strategy, query patterns) — deliberately out of scope; this is the logical schema the DB must implement, not the DB design itself.
