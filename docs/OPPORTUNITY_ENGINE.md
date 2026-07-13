# Opportunity Engine v3 — Merged Architecture Specification

This document merges v1 (graph/pipeline/agent/tie-break rigor) with v2
(Hypothesis Engine, Validation Engine, Founder Fit Engine) into one
buildable spec. It does not restate everything from v1 verbatim —
where v1 is unchanged, it is referenced by section number. Where v2
introduced a real improvement, it is grafted into v1's structure
rather than replacing it. Where the two contradicted each other, the
contradiction is resolved explicitly below, not silently.

**Freeze status**: this version incorporates the two structural
changes decided before freeze — `OpportunityCandidate` as a distinct
node (§2, §7, §8) and Weighted/Independence-Aware Evidence Validation
(§5.2, §6). Three items were explicitly deferred to post-freeze — see
§13.

---

## 0. Merge Decisions Log (read this first)

These are the specific conflicts between v1 and v2, and the resolution
adopted in this document. Nothing below is implicit.

| # | Conflict | Resolution |
|---|---|---|
| 1 | v1 had a deterministic tie-break (DECISION_ENGINE §5); v2 had none, just "Internal Ranking → Top N → Single Recommendation" | **v1's tie-break sequence is retained unchanged** (§7 below) and now also consumes `founder_fit` as an additional tie-break dimension, inserted after `confidence_score`, before `distribution_score`. |
| 2 | v2's output section says the user receives the single recommendation "along with... competing alternatives" — directly contradicting Principle 2 (Compression over Expansion) and v1's UX progressive-disclosure model | **Resolved in favor of v1.** Alternatives are never shown at default output. They exist only at Evidence Layer Level 2/3 (v1 UX.md §4), behind an explicit user action ("Why wasn't anything else recommended?"). v2's wording was an error, not a design decision — corrected here. |
| 3 | v2's `venture_score = Quality × Fit × Confidence` is multiplicative — a single near-zero Founder Fit zeroes out an otherwise-excellent opportunity | **Partially resolved as a gate + weighted term** (§8), not pure multiplication. The exact split (currently a 0.7/0.3 placeholder) is **deferred to post-freeze tuning** — see §13.3. |
| 4 | v2's "AI may synthesize" (Evidence A+B+C → Hypothesis) softens v1's strict Evaluator-not-Creator boundary without saying so | **Named explicitly, not hidden.** §4 defines synthesis as a bounded, auditable operation distinct from generation, with its own constraint clause — see "Bounded Synthesis Rule." Elevating this to a standalone Principle is **deferred to post-freeze** — see §13.4. |
| 5 | v2 dropped all of v1's engineering detail (agent roster mechanics, schema validation, ingestion cadence, extraction verification, memory lifecycle) | **All retained from v1 by reference**, unchanged. v2's contributions are additive nodes/agents/steps inserted into the existing v1 pipeline, not a replacement of it. |
| 6 | Opportunity node conflated two roles: pre-Compression scoring candidate and post-Compression terminal recommendation, distinguished only by `status` | **Resolved structurally.** A new `OpportunityCandidate` node type (§2) now holds everything before Compression. Only the Compression Agent's winner is promoted into an `Opportunity` node. This was one of the two changes locked before freeze. |
| 7 | Validation Agent's `validation_score` weighted evidence by per-node `confidence` only, with no check for source independence — duplicate/derivative sources could inflate support or contradiction artificially | **Resolved via Weighted Evidence Validation** (§5.2, §6): Evidence now carries `source_authority_tier` and a versioned `cluster_id`/`cluster_version` pair (not a single permanent `independence_cluster_id` — see §8's note below); Validation Agent weights and de-duplicates by cluster before computing `validation_score`. This was the second change locked before freeze. |
| 8 | `independence_cluster_id` was originally specified as a single, permanent field — but a permanent cluster assignment would force a full data migration the moment clustering quality improves (better embeddings, denser evidence graph) | **Split into `cluster_id` + `cluster_version`**, with a versioned Reclustering process defined in GRAPH_SCHEMA_SPEC.md §4.13. Already-computed `validation_score`/`confidence_score` values are stored, point-in-time results — they are not invalidated by a later Reclustering run; only genuine re-validation of a specific node picks up a new `cluster_version`. |

---

## 1. Principles (v1's ten, plus two from v2)

Unchanged from PRODUCT_PRINCIPLES.md (v1), principles 1–10, **plus**:

11. **Hypotheses Over Claims** (from v2) — the system never asserts a
    gap or opportunity exists as fact. It asserts a hypothesis with
    `evidence_for`, `evidence_against`, and `missing_data` explicitly
    represented. "Gap Suspected," never "Gap Found."
12. **Founder-Specific Decisions** (from v2) — there is no universally
    best opportunity, only the best opportunity *for this founder's*
    expertise, assets, capital, and constraints. This principle
    modifies how Principle 6 (Single Recommendation) is computed, not
    whether it holds — there is still exactly one output.

A candidate 13th principle ("AI may create hypotheses. AI may not
create evidence.") was proposed and is deliberately **not** added here
— see §13.4 for why it's deferred rather than rejected.

---

## 2. Node Types (v1 §3, extended)

All v1 node types (Market, Audience, Problem, Existing Solution,
Business Model) are retained with their base schema (`id`, `type`,
`label`, `created_at`, `last_seen_at`, `source_refs`, `status`,
`confidence`) unchanged.

### 2.1 Evidence node (made explicit, extended for Weighted Validation)

v1 referenced `source_refs` throughout but never gave Evidence its own
first-class schema in the graph layer (it lived in Data Pipeline's
normalized-record schema instead). It is elevated here because
Weighted Evidence Validation (§5.2) needs to reason over Evidence as
graph-traversable nodes, not just pipeline records:

```yaml
Evidence:
  id:
  type: evidence
  source_url_or_identifier:
  source_type:                  # review / forum / pricing_page / industry_report / etc — v1 Data Pipeline §3 categories
  source_authority_tier:        # new — e.g. industry_report > competitor_self_stated > forum_post > anonymous_comment
  cluster_id:                    # new — evidence traceable to the same underlying origin shares this id, within cluster_version below
  cluster_version:                # new — which Reclustering run produced cluster_id; versioned and mutable, see GRAPH_SCHEMA_SPEC.md §4.13
  extracted_fact:
  confidence:
  fetched_at:
  freshness:
```

`source_authority_tier` is populated at ingestion by the Data Pipeline
(v1 DATA_PIPELINE §5, extended, not replaced). `cluster_id`/
`cluster_version` are populated and periodically **re**-populated by a
versioned Reclustering process — full mechanics, including why
re-clustering does not retroactively invalidate already-computed
scores, are specified in `GRAPH_SCHEMA_SPEC.md` §4.13, which is now
the canonical source for Evidence lifecycle detail.

### 2.2 Hypothesis node (renamed and reframed from White Space, v1 §3.7)

Rationale: v2 correctly identified that "White Space" implied a
confirmed gap, which the system cannot actually establish (missing
competitor data ≠ market gap). The node type is kept in the same graph
position (same edges in/out), only its semantics and schema change:

```yaml
Hypothesis:            # replaces White Space node (v1 §3.7)
  id:
  type: hypothesis
  label:
  statement:                    # e.g. "EU SMB compliance software may be underserved"
  gap_type:                     # positioning / pricing / business-model / distribution — kept from v1 §3.7
  evidence_for: [evidence_id...]
  evidence_against: [evidence_id...]
  missing_data: [string...]     # explicitly named unknowns, not silently omitted
  confidence:                    # composite — see §6
  validation_score:              # new — set by Validation Agent, §5.2
  created_at:
  last_seen_at:
  status: active | deprecated | merged
```

Still "only ever produced, never input" (v1 §3.7), and still cannot
contain a solution description — no such field exists in the schema
(v1 AI_AGENTS §7 guardrail preserved unchanged).

### 2.3 Founder node (new, from v2)

Added as a first-class node (not a config parameter), because Founder
Fit needs to be scored, versioned, and reused across runs the same way
any other node is:

```yaml
Founder:
  id:
  type: founder
  expertise: [string...]
  industries: [string...]
  geography:
  capital_availability:
  distribution_assets: [string...]   # e.g. existing newsletter, audience channel
  audience_assets: [string...]
  team_size:
  constraints: [string...]
  created_at:
  last_updated_at:
```

### 2.4 OpportunityCandidate node (new — locked-in structural change)

This is the single most important structural fix in v3. Previously,
one `Opportunity` node type had to represent both "a scored candidate
still competing in Compression" and "the terminal recommendation the
user sees" — distinguished only by a `status` flag. That ambiguity
becomes a real liability once Memory starts building `supersedes`
chains and Outcome links against it. `OpportunityCandidate` now owns
everything pre-Compression:

```yaml
OpportunityCandidate:
  id:
  type: opportunity_candidate
  constituent_node_ids:      # Market/Audience/Problem/Hypothesis/BusinessModel — full composes chain, v1 §3.8 rule retained
  opportunity_quality:        # the six-component weighted sum, v1 DECISION_ENGINE §4
  founder_fit_score:          # output of Founder Fit Agent, §5.3
  founder_fit_rationale:
  venture_score:               # combined per §8
  confidence_score:            # composite, §6
  status: candidate | deprecated   # deprecated = lost Compression or failed a gate, retained not deleted (v1 §6)
  created_at:
  last_seen_at:
```

**`Opportunity` (v1 §3.8) is now strictly the terminal, promoted
node** — the one and only candidate that won Compression for a given
run:

```yaml
Opportunity:
  id:
  type: opportunity
  promoted_from_candidate_id:   # new — traceability back to §2.4
  # venture_score, confidence_score, founder_fit_score, founder_fit_rationale,
  # rationale_bullets, risk_summary — all copied at promotion time from the
  # winning OpportunityCandidate, not recomputed
  constituent_node_ids:
  created_at:
```

Promotion happens exactly once per successful Compression run, via
the Compression Agent (§5, updated), and is the only path by which an
`Opportunity` node comes into existence. This makes `supersedes`
edges (v1 §4) and Outcome links (§2.5) unambiguous: they always point
at a terminal, once-recommended node, never at a candidate that was
merely considered.

### 2.5 Outcome node (new, formalizing v1 §5 tracking)

Formalizes what v1's Memory subsystem tracked informally (v1
OPPORTUNITY_MEMORY §5) as an actual graph node rather than only a
Memory-internal record — this makes outcome data traversable and
citable the same way evidence is:

```yaml
Outcome:
  id:
  type: outcome
  opportunity_id:       # always an Opportunity node (§2.4), never a Candidate
  signal_type:           # building_this / rejected / re_ran / self_reported / no_signal — v1 §5.1 taxonomy retained
  signal_strength:       # strong / medium / weak-negative / neutral
  reason_tag:            # optional, e.g. "too capital intensive"
  reported_at:
  confidence:            # self-reported outcomes get a distinctly lower default confidence — v1 §5.2 rule retained
```

---

## 3. Edge Types (v1 §4, extended)

All v1 edges (`contains`, `has_audience`, `experiences`,
`addressed_by`, `competes_with`, `monetizes_via`, `supersedes`) are
retained unchanged. `reveals` (Problem/Solution → White Space) is
retargeted to point at the renamed Hypothesis node.

**`composes` now points into `OpportunityCandidate`, not directly into
`Opportunity`** (v1 §4's original target) — this is the edge-level
consequence of §2.4's structural change.

New edges:

| Edge Type | From → To | Meaning |
|---|---|---|
| `supports` | Evidence → Hypothesis | Evidence backs a hypothesis statement |
| `contradicts` | Evidence → Hypothesis | Evidence weighs against a hypothesis statement |
| `co_clustered_with` | Evidence → Evidence | Two Evidence nodes share a `cluster_id` under the current `cluster_version` — used by Validation Agent weighting, §5.2; scoped to a version because clustering is versioned (GRAPH_SCHEMA_SPEC.md §4.13) |
| `fits` | Founder → OpportunityCandidate | Founder Fit Agent scored this as executable for this founder |
| `does_not_fit` | Founder → OpportunityCandidate | Founder Fit Agent scored this below the fit gate threshold (§8) |
| `promotes` | OpportunityCandidate → Opportunity | Compression Agent's terminal promotion — exactly one per run, per §2.4 |
| `resolves` | Outcome → Opportunity | An Outcome node records what happened to a specific (terminal) recommendation |

---

## 4. Bounded Synthesis Rule (resolves Merge Decision #4)

v1's absolute rule was: *no agent creates a Market, Audience, Problem,
or Business Model node without a source_ref; agents extract, they do
not brainstorm* (AI_AGENTS §2).

v2 introduces one narrow, named exception, and only one:

> **The Hypothesis Agent (only) may combine two or more existing,
> sourced Evidence nodes into a new Hypothesis statement that does not
> appear verbatim in any single source.** This is synthesis, not
> generation, and is bounded by three hard constraints:
>
> 1. Every Hypothesis must cite at least two independent `source_refs`
>    it was synthesized from (`evidence_for`) — a hypothesis built
>    from a single source is rejected as insufficiently evidenced,
>    not created as low-confidence. "Independent" here means distinct
>    `cluster_id`s under the current `cluster_version` (§2.1) — two
>    derivative copies of the same origin no longer count as two.
> 2. The Hypothesis Agent must also populate `evidence_against` and
>    `missing_data` in the same output — a hypothesis with an empty
>    `evidence_against` array is not accepted by the Orchestrator
>    without the Validation Agent (§5.2) explicitly confirming no
>    contradictory evidence was found, rather than none being sought.
> 3. **No other agent in the roster (§5) has this synthesis
>    permission.** Discovery, Expansion, Competitive Analysis remain
>    pure extraction agents exactly as in v1 AI_AGENTS §6 — this
>    exception does not generalize.

This makes the loosening auditable: it is one agent, one node type,
with two structural guardrails, not a general relaxation of Principle
8.

---

## 5. Agent Roster (v1 §3, extended)

v1's nine agents (Discovery, Expansion, Filtering, Competitive
Analysis, Scoring, Compression, Memory, Orchestrator) are retained
unchanged in responsibility and constraints, with Compression's
output changed per §2.4. The White Space Agent (v1 §4.5) is renamed
**Hypothesis Agent** and its role updated per §4 above. Two new agents
are inserted into the pipeline between it and Scoring:

### 5.1 Hypothesis Agent (replaces White Space Agent, v1 §4.5)

**Input**: Problem × Existing Solution subgraphs (unchanged from v1).
**Output**: Hypothesis nodes via `reveals` edges, populated per the
Bounded Synthesis Rule (§4).
**Constraint**: still cannot output a solution description (schema
guardrail retained from v1 AI_AGENTS §7) — synthesis permission
covers gap *hypotheses*, never solution proposals.

### 5.2 Validation Agent (new — includes Weighted Evidence Validation, locked-in change)

**Input**: a Hypothesis node with its `evidence_for` set.
**Output**: an active search for `evidence_against` beyond what the
Hypothesis Agent already found, plus `unresolved_questions`, plus a
`validation_score`.

**Weighting mechanics (the second locked-in freeze change):**

1. Group all `evidence_for`/`evidence_against` Evidence nodes by
   `cluster_id` (under the current `cluster_version`, §2.1). Evidence
   sharing a cluster is collapsed into one weighted vote, not counted
   per-item — this directly closes the gap where five forum posts
   quoting the same original Reddit thread previously counted as five
   independent confirmations. Because clustering is versioned, this
   grouping can improve over time (Reclustering, GRAPH_SCHEMA_SPEC.md
   §4.13) without requiring a data migration.
2. Within each cluster, weight by the highest `source_authority_tier`
   present in that cluster (an industry report and a forum post
   citing it are one cluster, weighted at the report's tier, not
   averaged down).
3. `validation_score` = (sum of cluster-weighted supporting evidence)
   − (sum of cluster-weighted contradictory evidence), each further
   scaled by per-node `confidence` and `freshness` as in the prior
   (unweighted) formulation.

**Constraint**: this agent's entire job is adversarial — it is
evaluated (and can be audited) on whether it *actively sought*
disconfirming evidence via the Data Pipeline, not merely absence of
objection. A Validation Agent output with an empty
`contradictory_evidence` array and no logged additional queries
against Data Pipeline is rejected by the Orchestrator as incomplete,
same enforcement mechanism as v1's schema-validation gate (AI_AGENTS
§9).

**Gate**: a Hypothesis only proceeds toward an OpportunityCandidate
if `validation_score` clears a configured threshold (default:
net-positive after cluster and confidence weighting). Hypotheses that
fail are marked `deprecated` with reason `failed_validation` — never
deleted, consistent with v1's retention-not-deletion rule (v1
OPPORTUNITY_GRAPH §6).

### 5.3 Founder Fit Agent (new)

**Input**: a Founder node + a scored OpportunityCandidate (post
Scoring, pre-Compression).
**Output**: `founder_fit_score` (0–100) and `founder_fit_rationale` on
the OpportunityCandidate (§2.4), derived from comparing the
candidate's required distribution/capital/expertise profile (inferred
from its Business Model and Market nodes) against the Founder node's
`distribution_assets`, `capital_availability`, `expertise`.
**Constraint**: this agent does not re-score the candidate's inherent
quality (that's the Scoring Agent's job, unchanged from v1 §4.6) — it
produces an independent, separately-reported number, combined per
§8's gate-plus-weighted formula.
**Placement in pipeline**: runs after Scoring, before Compression —
Compression Agent now consumes each OpportunityCandidate's
`venture_score` (already incorporating `founder_fit_score` per §8),
not a bare `opportunity_quality` alone.

### 5.4 Compression Agent (v1 §4.7, updated for §2.4)

**Input**: scored, gated OpportunityCandidate nodes.
**Output**: applies the fixed tie-break sequence (§7) exactly as
specified, then **promotes** the single winning candidate into a new
`Opportunity` node via a `promotes` edge (§3) — copying its scores and
rationale at promotion time rather than recomputing them. All other
candidates remain `OpportunityCandidate` nodes with `status:
deprecated`, retrievable, never deleted.
**Constraint**: no discretionary override of the tie-break sequence —
unchanged from v1 §4.7.

### 5.5 Orchestrator (v1 §4.9, extended)

Retains all v1 responsibilities (schema rejection, pipeline ordering,
no-partial-output rule) and additionally enforces:

- The Bounded Synthesis Rule (§4) — rejects any Hypothesis Agent
  output missing `evidence_against`/`missing_data` fields, or any
  non-Hypothesis-Agent output that attempts synthesis rather than
  extraction.
- The Founder Fit gate (§8) before an OpportunityCandidate can be
  considered by Compression.
- That exactly one `promotes` edge is created per successful run
  (§2.4, §5.4) — more than one, or zero on a run that reached
  Compression, is a hard failure, not a silent partial output.

---

## 6. Confidence Model (v2's multidimensional model, adopted in full, extended for weighting)

v1 had a single scalar `confidence` field per node. This is now
decomposed, per v2, into three components computed for every
Hypothesis and OpportunityCandidate node:

```yaml
Coverage:    # how much relevant data exists — was implicit in v1's source_refs count
Agreement:   # consistency across INDEPENDENT sources — now explicitly cluster-aware (§2.1, §5.2): agreement among five copies of one source no longer inflates this component
Freshness:   # recency-weighted — already tracked in v1 Data Pipeline §9, now surfaced as a named component
```

`confidence_score` (v1 DECISION_ENGINE §4.2) is a function of these
three, not a bare weighted average of node-level `confidence` fields.
Because `Agreement` is now computed over `cluster_id` (within the
current `cluster_version`) groups rather than raw source count, this
directly inherits the fix
from Weighted Evidence Validation (§5.2) — the same duplication
problem that could inflate `validation_score` could previously also
inflate `Agreement`, and both are now closed by the same mechanism.

---

## 7. Decision Engine — Convergence (v1 §5, retained, extended for §2.4)

Operates over `OpportunityCandidate` nodes (not `Opportunity` nodes,
per §2.4). v1's deterministic tie-break sequence is kept **exactly**,
with one insertion (bolded):

1. Rank all surviving candidates by `venture_score` (§8), descending.
2. If the top candidate exceeds the second by more than the
   configured margin (default: 5 points), select it. Done.
3. If within margin, break the tie in this fixed order:
   a. Higher `confidence_score` wins.
   **a2. Higher `founder_fit_score` wins.** *(new — inserted here
   because a tie in raw opportunity quality and evidential confidence
   should resolve toward what this specific founder can actually
   execute, which is the entire point of adding Founder Fit at all)*
   b. Higher `distribution_score` wins.
   c. More recent supporting evidence (`last_seen_at`) wins.
   d. Lower `operational_complexity_estimate` wins.

The selected candidate is **promoted** to an `Opportunity` node (§2.4,
§5.4). All non-selected candidates remain `deprecated`
`OpportunityCandidate` nodes, retrievable, never deleted — unchanged
in spirit from v1.

---

## 8. Venture Score Formula (resolves Merge Decision #3, partially — see §13.3)

v1's six-component weighted sum (`demand_score`, `hypothesis_score`
[formerly `white_space_score`], `margin_score`, `feasibility_score`,
`distribution_score`, `timing_score`) is retained as the base
`opportunity_quality` computation, unchanged in mechanics (v1
DECISION_ENGINE §4), computed per `OpportunityCandidate`.

Founder Fit is combined as **gate, then weighted term**, not
multiplication:

```
Step 1 — Gate:
  if founder_fit_score < minimum_fit_threshold (default: 25/100):
      exclude candidate from Compression entirely
      (same treatment as v1's "incomplete composes chain" exclusion,
      DECISION_ENGINE §10 — excluded before scoring, not scored and
      penalized to near-zero)

Step 2 — Weighted combination (candidates that pass the gate):
  venture_score =
      (0.7 × opportunity_quality)     # v1's existing 6-component formula
    + (0.3 × founder_fit_score)
      # NOTE: the 0.7/0.3 split is a placeholder, explicitly flagged
      # for reconsideration post-freeze — see §13.3. Do not treat
      # this ratio as validated.

Step 3 — confidence_score reported separately, as in v1 §4.2 —
  never folded into venture_score itself.
```

This preserves v2's correct instinct (fit matters enough to be
load-bearing) while fixing its flaw (multiplication lets one weak
input erase an otherwise strong opportunity).

---

## 9. Memory / Learning System (v1 + v2 phases merged)

v1's Opportunity Memory (user-scoped + aggregate, lifecycle,
resurrection, weight tuning) is retained in full (v1
OPPORTUNITY_MEMORY.md), now operating over the split
`OpportunityCandidate`/`Opportunity` node types (§2.4) — resurrection
applies to deprecated `OpportunityCandidate` nodes; `supersedes`
applies only between `Opportunity` nodes. v2's three-phase learning
framing sits on top as the tuning cadence model:

- **Phase 1 (= v1 MVP default)**: heuristic weighting, fixed
  `w1..w6` and fixed 0.7/0.3 quality/fit split (placeholder, §13.3).
- **Phase 2 (= v1 Roadmap Phase 1)**: outcome-informed weighting,
  using the Outcome node (§2.5) as the traceable record.
- **Phase 3**: outcome-trained ranking — post-Roadmap-Phase-1 future
  work, not committed to a mechanism here.

---

## 10. Output Contract (resolves Merge Decision #2)

Per v1 UX.md §3 and §4, unchanged:

- **Default output**: the promoted `Opportunity` node — name,
  `venture_score`, `confidence_score` (with Coverage/Agreement/
  Freshness breakdown at Level 2), `founder_fit_rationale`, rationale
  bullets, risk summary.
- **Competing alternatives are never part of default output.**
  Alternatives (deprecated `OpportunityCandidate` nodes) are available
  only at Evidence Layer Level 3 (v1 UX.md §4), via the explicit "Why
  wasn't anything else recommended?" action.
- Hypothesis-level transparency (`evidence_for` / `evidence_against` /
  `missing_data`, now with cluster-weighted validation detail) is
  available at Level 2, alongside the existing sub-score breakdown.

---

## 11. MVP Scope (v1 MVP.md, extended minimally)

Everything in v1 MVP.md §2–§8 holds. Additions for the merged v3
architecture:

- **Hypothesis Agent and Validation Agent (with weighting) ship at
  MVP** — same pipeline slot as the old White Space Agent, better
  semantics and one added weighting step, not additional scope.
- **`OpportunityCandidate`/`Opportunity` split ships at MVP** — this
  is a schema decision, not a deferred feature; retrofitting it after
  real Candidate/Opportunity data exists would require a data
  migration, which is exactly why it was locked before freeze.
- **Founder Fit Agent ships at MVP but with a minimal Founder node**
  — only `expertise`, `distribution_assets`, `capital_availability`
  captured at first; fuller profile is additive later.
- **Outcome node ships at MVP** as a formal graph node, linked only to
  promoted `Opportunity` nodes (§2.5), so Founder Fit tuning (Phase 2,
  §9) has traceable outcome-to-founder-profile links from day one.
- Everything else deferred in v1 MVP.md (aggregate memory, 4-vertical
  coverage, full 4-dimension white space, Level 3 evidence) remains
  deferred, unchanged.

---

## 12. Summary

v3 is v1's graph, pipeline, agent roster, deterministic tie-break, and
data pipeline discipline — with three grafted additions from v2
(Hypothesis framing instead of asserted gaps, adversarial Validation,
Founder-specific Fit) — with the places v2 quietly weakened v1's
guarantees explicitly named and re-tightened, and with two additional
structural fixes locked in before freeze: a distinct
`OpportunityCandidate` node separating in-flight scoring from the
terminal recommendation, and cluster/authority-aware Weighted Evidence
Validation closing the duplicate-source blind spot in both
`validation_score` and the `Agreement` confidence component. Three
further refinements were identified and deliberately deferred rather
than rushed into this freeze — see §13.

---

## 13. Deferred — Post-Freeze

These were raised during review, judged non-structural (cheap or safe
to change after freeze without a data migration), and intentionally
left open rather than resolved with an unvalidated placeholder.

### 13.1 Status
Not yet implemented. Tracked here so they aren't lost, not because
they're unimportant.

### 13.2 Item: Explicit "AI may create hypotheses, may not create
evidence" principle
Currently implicit in the Bounded Synthesis Rule (§4). Elevating it to
a standalone Principle (distinct from Principle 11, which is about
epistemic honesty of output, not agent permission boundaries) is a
documentation-only change — no schema or pipeline impact. Do
whenever, including post-launch.

### 13.3 Item: Founder Fit combination formula
The current 0.7/0.3 additive split (§8) is a placeholder illustrating
mechanism (gate + weighted term), not a validated ratio. A candidate
alternative worth evaluating post-freeze:

```
fit_multiplier = 0.6 + 0.4 × (founder_fit_score / 100)   # range 0.6–1.0
venture_score = opportunity_quality × fit_multiplier
```

This keeps the proportional-influence intuition from v2 without
letting a single weak input zero out a strong opportunity, and avoids
committing to an arbitrary weight pair before any outcome data exists.
Changing this later only affects a scoring function, not stored graph
structure — safe to defer.

### 13.4 Item: Proprietary Dataset Strategy section
Not yet written. Should address: which data assets are commodity
(market/competitor/review data — reproducible by any well-funded
competitor) versus which compound uniquely (Outcome nodes, §2.5 —
only accumulate through real product usage). Recommendation to carry
into that section when written: prioritize Outcome-signal collection
aggressively from MVP day one, even while Discovery/Competitive
coverage is thin, since Outcome data — not source breadth — is the
only asset here that isn't trivially copyable. Deferred because it's
a resourcing/strategy document, not an architecture dependency — it
doesn't block anything else in this spec.
