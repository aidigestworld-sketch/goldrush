# Opportunity Engine — MVP_IMPLEMENTATION_PLAN.md

## Bridging ARCHITECTURE(v3) → GRAPH_SCHEMA_SPEC → DATABASE_SCHEMA →
## AI_AGENTS → AGENT_EXECUTION_DAG into an actual build order

---

## 0. Pre-Flight Cleanup (done as part of writing this document)

Two items flagged in prior documents as "resolve before implementation"
were closed just now, not left to rot into the build phase:

1. **`opportunity_candidate.run_id`** added as a direct FK
   (DATABASE_SCHEMA.md §3.9) — Compression's run-level readiness check
   (AGENT_EXECUTION_DAG.md §5.2) needed this to be a cheap indexed
   query instead of a transitive walk through the composition chain.
2. **`validates`/`invalidates` edges removed** from
   GRAPH_SCHEMA_SPEC.md and OPPORTUNITY_ENGINE_V3_MERGED.md — flagged
   for removal in AI_AGENTS.md §19/§20 three documents ago, never
   actually applied until now.

Everything else flagged-but-deferred across the prior six documents
(Founder Fit 0.7/0.3 split, Principle 13 formalization, Proprietary
Dataset Strategy, existing_solution/business_model deprecation path)
remains deliberately open — see §6 for the consolidated list and why
each is safe to build MVP without.

---

## 1. Scope Boundary (what "MVP" means here, restated once, precisely)

One vertical. One founder profile per run. Three data source types
(per v1 MVP.md — search/demand signal, review/complaint signal,
competitor material). Heuristic (untuned) `scoring_config` and
`model_routing_config` at version 1. No Reclustering runs yet (only
one clustering pass at ingestion — versioning exists in the schema,
but there's nothing to re-cluster against until enough Evidence
accumulates). No resurrection (nothing has been deprecated long enough
to be a candidate for it). Memory Agent ships with only the two
capabilities that don't need historical volume to be meaningful:
Outcome capture (so Phase 2 tuning has data to work with *eventually*)
and the merge/dedup pass (§7 of AGENT_EXECUTION_DAG.md's cross-run
duplication answer needs this running from day one, even at low
volume).

**Definition of Done for MVP**: a single `pipeline_run`, triggered for
one real founder profile in one vertical, executes end-to-end through
every stage in AGENT_EXECUTION_DAG.md §3, and terminates in exactly one
of: (a) one promoted `Opportunity` with full rationale, risk summary,
and a traceable evidence chain down to individual `evidence` rows; (b)
`insufficient_evidence`, if every candidate was excluded; (c) `failed`,
with a `failure_reason` naming the stage and cause. All three outcomes
are visible in `agent_execution_log` end-to-end, and none of them ever
produces a partial recommendation presented as complete.

---

## 2. Build Order

Ordered by what unblocks what, not by document sequence — deterministic
pieces before LLM-dependent ones, because deterministic code is
testable without touching a model at all, and every dependent stage's
correctness can be verified against fixtures before real ingestion
exists.

### Phase 0 — Infrastructure
- Postgres instance (Railway), `pgvector` extension enabled.
- Migration tool wired into the existing Fastify project (whatever's
  already used elsewhere in the stack — no new tool introduced here,
  per DATABASE_SCHEMA.md §10).
- NIM API key provisioned (build.nvidia.com); confirm the specific
  model ids for each tier in AI_AGENTS.md §16 actually resolve in the
  NIM catalog before writing any agent code against them.
- Redis: session/cache layer for Data Pipeline's rate-limiting and
  caching (v1 DATA_PIPELINE §8) — reuse existing Redis instance.

### Phase 1 — Schema
- Run every DDL block from DATABASE_SCHEMA.md, in true dependency
  order (founder → pipeline_run → structural node tables → evidence →
  node_source_refs → hypothesis → opportunity_candidate →
  opportunity_candidate_composition → opportunity → outcome →
  scoring_config → model_routing_config → agent_execution_log), plus
  the `deprecation_reason` patch and `business_model` write-permission
  fix from AI_AGENTS.md §0.
- Seed `scoring_config` version 1 and `model_routing_config` version 1
  by hand (Memory Agent doesn't exist yet to write them, and doesn't
  need to for a single MVP vertical).
- Write and run one integration test per table: insert a row
  satisfying every `CHECK` constraint, confirm one violating each
  constraint is rejected. This is cheap and catches schema-contract
  mismatches before any agent code depends on them.

### Phase 2 — Data Pipeline (non-agent)
- Ingestion + normalization + caching + rate-limiting + verification
  sampling for the 3 MVP source types (v1 DATA_PIPELINE.md, unchanged
  by any later document).
- This is deliberately built *before* any agent, since Discovery/
  Expansion/CompetitiveAnalysis all consume its output and cannot be
  meaningfully tested without it existing first.
- **Evidence Yield + Diversity gate (§4, risk 0)**: before moving to
  Phase 4, run the manual/non-agent extraction pass described in §4
  against this phase's actual ingested output for the MVP vertical —
  checking both volume and cluster diversity, not volume alone. This
  is a go/no-go checkpoint, not a formality — if it comes back thin on
  either dimension, fix sourcing or narrow the vertical here, before
  any agent is built around an assumption of sufficient, independent
  evidence that doesn't hold.

### Phase 2.5 — Extraction Sandbox (inserted after architect review)

Before investing in Phase 3's deterministic layer or Phase 6's
Orchestrator, de-risk the one assumption none of the prior six
documents actually tested: **can an LLM turn real source text into
correctly-shaped, evidence-grounded graph nodes at all?** This is
Evidence Yield Risk (§4, risk 0) one layer deeper — yield answered "is
there enough raw material," this answers "can it actually be
structured."

No DAG, no Orchestrator, no `pipeline_run`, no retries, no DB writes —
just `raw documents -> prompt -> validated JSON`, run directly against
each of the three extractive agents' real prompts and contracts
(AI_AGENTS.md §1–§4), one at a time:

- **Discovery Sandbox** — built first, since Composition later needs a
  Market row to exist before Expansion's `has_audience`/`experiences`
  edges have anywhere to attach. Tests Discovery's actual contract:
  `search_signal | marketplace | industry_report | financial_signal`
  documents in, Market candidates out, every one evidence-grounded
  (empty `evidence_refs` or a citation to a document id that doesn't
  exist in the input = a Bounded Rule violation, flagged not silently
  accepted).
- **Expansion Sandbox** — arguably the more important of the two, and
  should not be deferred: this is where the project's actual central
  bet (symptom ≠ cause) first becomes checkable, since Expansion is
  the agent that turns a review/complaint like "customers cancel
  subscriptions" into a `Problem` node — ideally something closer to
  "forced/misattributed churn" than a shallow restatement of the
  complaint. `VERTICAL_BASELINE.md` §6's Shop Pay example is the
  acid test here, not for Discovery.
- **CompetitiveAnalysis Sandbox** — kept separate from Discovery
  deliberately (narrow single-responsibility, same reasoning as the
  agent roster itself, AI_AGENTS.md §0) — named competitors in,
  ExistingSolution/BusinessModel candidates out.

A sandbox result that never produces a real evidence-grounded
Market/Problem/ExistingSolution — or one where Expansion never
surfaces anything beyond the surface-level complaint — is a genuine,
concrete finding about the extractive agents themselves, discovered
before Phase 6's Orchestrator investment, not after.

### Phase 3 — Deterministic Agents (no model calls, build and test first)
- Filtering, Composition, Scoring (`compute_venture_score`),
  Compression (tie-break + gate + promotion transaction). These are
  pure functions over already-shaped graph data — unit-testable
  against hand-built fixture graphs without any LLM or even real
  ingested data. Getting these right first means every later
  integration test has a trustworthy downstream to check against.
- Compression's promotion transaction (DATABASE_SCHEMA.md §8) and the
  outcome/append-only trigger (§7) are built and tested here too.

### Phase 4 — Extractive LLM Agents (NIM low-cost tier)
- Discovery, Expansion, CompetitiveAnalysis — the real, DB-writing,
  Orchestrator-driven versions of what Phase 2.5's sandboxes already
  proved out at the prompt/output level. Wire to NIM per AI_AGENTS.md
  §16's low-cost tier. Test against Phase 2's real ingested data for
  the one MVP vertical.

### Phase 5 — Reasoning Agents (NIM mid-tier)
- Hypothesis (Bounded Synthesis Rule enforcement is the one thing to
  test hardest here — a unit test that feeds it single-source
  evidence and asserts rejection, not low-confidence acceptance).
- Validation (Collector) — test that it logs at least one additional
  Data Pipeline query per hypothesis, per its invariant.
- Confidence (both modes) — test cluster-weighted aggregation
  specifically against a fixture with duplicate-cluster evidence, to
  confirm the five-forum-posts-one-thread case is actually collapsed,
  not just theoretically specified.
- FounderFit — test against at least two contrasting Founder profiles
  against the same candidate, confirming the score meaningfully
  differs.

### Phase 6 — Orchestrator
- DAG execution from `depends_on:` declarations (AI_AGENTS.md §17),
  transaction-per-stage (AGENT_EXECUTION_DAG.md §4), retry policy
  (§4), the two-level Compression readiness check (§5.1/§5.2), and
  Field-Write Grant enforcement (AI_AGENTS.md §18) — this last one is
  worth a dedicated test: construct an agent output that writes an
  ungranted field and confirm the Orchestrator rejects it before it
  reaches the graph, not after.
- This phase is where all five prior documents' invariants actually
  get enforced together for the first time — treat it as the
  integration-test-heaviest phase, not just glue code.

### Phase 7 — Memory Agent (minimal MVP slice only)
- Outcome capture path (trivial — just an insert path from wherever
  the user records a reaction to a recommendation).
- Cross-run merge/dedup pass (AGENT_EXECUTION_DAG.md §7), including the
  provenance-union rule (GRAPH_SCHEMA_SPEC.md §4.1/§4.7 patch) — this
  one is worth testing explicitly: merge two fixture nodes with
  different `source_refs` sets and assert the survivor has the union,
  not either original set alone.
- Weight tuning and Reclustering are NOT built in this phase — nothing
  to tune yet (§1). Stub the scheduled job so it exists as a hook, but
  its actual tuning logic is out of MVP scope.

### Phase 8 — Output / UX
- Single-recommendation display, Level 2/3 progressive disclosure (v1
  UX.md), pulling `rationale_bullets`, `risk_summary`,
  `founder_fit_rationale`, and the Coverage/Agreement/Freshness
  breakdown from the promoted `Opportunity` row.

### Phase 9 — End-to-End Smoke Test
- One real founder profile, one real vertical, full run,
  Discovery-through-Compression, inspected against the Definition of
  Done in §1. This is the actual MVP acceptance test — not a unit
  test, a full live run.

---

## 3. What's Explicitly NOT Built in MVP (consolidated)

| Item | Why it's safe to skip now |
|---|---|
| Weight tuning (Phase 2 learning, v3 §9) | No outcome data exists yet to tune against — building it now would tune against nothing |
| Reclustering execution (mechanism exists, not run) | Not enough Evidence volume in one vertical to make re-clustering meaningful yet |
| Resurrection | Nothing has been deprecated long enough to resurrect |
| Founder Fit 0.7/0.3 formula validation | Flagged placeholder from day one (v3 §8/§13.3) — needs outcome data, same as weight tuning |
| Proprietary Dataset Strategy document | Strategy/resourcing document, not a build blocker (v3 §13.4) |
| Principle 13 formalization | Documentation-only, zero code impact (v3 §13.2) |
| existing_solution/business_model deprecation path | No pruning logic specified yet for competitor-derived nodes — flagged, not urgent at MVP's data volume |
| Multi-vertical support | v1 MVP.md's original constraint, unchanged by anything since |
| **Populating the 5 chronic-null scoring inputs**: `market.growth_rate_estimate`, `audience.willingness_to_pay_signal`, `audience.acquisition_channels_known`, `business_model.margin_profile`, `business_model.operational_complexity_estimate`, `business_model.capital_intensity_estimate` | Two distinct root causes, both accepted for MVP: (i) `growth_rate_estimate`, `margin_profile`, `capital_intensity_estimate`, `acquisition_channels_known` — the sandbox schemas already request them but the current MVP source-type mix (Reddit review-complaint, competitor material, industry report) rarely carries a groundable value; validated by `experimentGroundedFieldExtraction.ts`. (ii) `willingness_to_pay_signal` and `operational_complexity_estimate` — a separate gap identified by the P1.1/P2.1 investigation: the corresponding sandbox extraction schemas (`AudienceCandidateSchema` in expansionSandbox.ts, `BusinessModelCandidateSchema` in competitiveAnalysisSandbox.ts) don't ask the LLM for these fields at all, AND the repositories (audienceRepository.create, businessModelRepository.create) have no slots to write them even if extracted. Schema+repository work is required BEFORE new source-type connectors could help these two, so they're not just source-coverage-limited. Scoring silently pads all five with a neutral 0.5 (constant preserved for byte-identical opportunity_quality), and the P1.1/P2.1 fix exposes per-field `scoringInputProvenance` on the ScoringOutput so audit/rationale can see how much of the score is grounded vs padded. |

---

## 4. Risk Areas Worth Front-Loading Attention

Ranked by how expensive they'd be to discover *after* Phase 9 rather
than during build:

0. **Evidence Yield Risk — the actual foundational risk, not #3.**
   Every document from ARCHITECTURE(v3) through AGENT_EXECUTION_DAG.md
   answers *how to reason* over evidence once it exists. None of them
   validate the one assumption everything else stands on: that
   Discovery, Expansion, and CompetitiveAnalysis can actually extract
   sufficient, usable evidence from real demand/review/competitor
   sources for the one MVP vertical. This isn't hypothetical risk —
   the prior scraping layer for this project's earlier iteration never
   became functional and had to be bypassed with sample data. If the
   same thing happens here, no amount of correctness in Hypothesis,
   Confidence, or the Orchestrator's grant enforcement matters — there
   is nothing for them to operate on.

   **Gate**: before Phase 4 agent implementation begins, run a manual
   (or lightly-scripted, non-agent) extraction pass against the one
   MVP vertical's three source types — no LLM synthesis, no scoring,
   just: can enough raw, citable, non-garbage evidence be pulled for
   at least a handful of Problem/ExistingSolution pairs to make
   Composition possible at all? The gate is **two-part, not one**:

   1. **Evidence Yield** — sufficient raw volume exists.
   2. **Evidence Diversity** — that volume spans multiple independent
      `cluster_id` groups, not one. Yield alone is misleading: 50
      evidence rows sourced from one Reddit thread pass a volume check
      easily but carry almost no real weight once Confidence Agent's
      cluster-weighting (AI_AGENTS.md §7) collapses them into a single
      vote — the same duplication problem the whole cluster/weighting
      mechanism exists to catch (AI_AGENTS.md §5.2/§7) is exactly what
      a yield-only check would miss at this earlier, pre-agent stage.
      A quick proxy is enough here — even a rough same-origin/
      same-domain grouping by hand, not a full embedding-based
      Reclustering pass — the point is confirming *some* independent
      corroboration exists per vertical, not precise cluster counts.

   If either half comes back thin — enough volume but from one
   cluster, or genuinely too little of everything — that's a signal to
   either narrow the vertical further, diversify data sources, or
   revisit source_authority_tier assumptions — cheaper to learn now
   than after Phases 4–6 are built around an assumption that doesn't
   hold.

1. **NIM model availability/latency for the mid-tier reasoning agents**
   (Phase 5) — Hypothesis/Validation/Confidence/FounderFit are the
   agents doing the most cognitively demanding work; confirm the
   chosen NIM models actually handle Bounded Synthesis-style tasks
   adequately before committing the full agent roster to that tier.
   If they don't, that's a Phase 5 finding, not a Phase 9 one.
2. **Orchestrator's Field-Write Grant enforcement** (Phase 6) — this is
   the single control point standing between "agents write only what
   they're contracted to" and "agents write whatever" (the original
   concern that started the AI_AGENTS.md rewrite). It deserves
   disproportionate test coverage relative to its code size.
3. **Bounded Synthesis Rule's actual enforceability** (Phase 5) — the
   two-independent-cluster-sources requirement is easy to state and
   easy to accidentally satisfy with technically-distinct-but-
   practically-identical sources if cluster assignment (Reclustering
   mechanism, run once at ingestion for MVP) isn't tuned well from the
   start.

---

## 5. Summary

Nine phases, ordered so that everything testable without a model call
gets built and verified first (Phases 0–3), extractive agents come
before reasoning agents (Phase 4 before 5, matching the actual
cognitive load difference AI_AGENTS.md §16 already encodes in model
tier assignment), the Orchestrator that ties every prior document's
invariants together is treated as the heaviest integration-test phase
rather than glue code (Phase 6), and Memory ships with only the two
capabilities that don't require historical data to be meaningful
(Phase 7). The explicit non-scope list (§3) is the same set of
placeholders flagged across the last six documents, now gathered in
one place instead of scattered. The risk ranking in §4 leads with
Evidence Yield, not model or orchestration concerns — every other
document in this stack assumed evidence extraction works; nothing
until this pass actually gated on checking that before building
further on top of it.
