# MVP_VERTICAL.md

**Vertical:** Shopify Subscription & Reorder Apps
**Status:** LOCKED FOR MVP

---

## Gate Results

| Gate | Result |
|---|---|
| Evidence Yield | PASS |
| Evidence Diversity | PASS |
| Independence | PASS |
| Opportunity Discovery Test | PASS |

Full detail and methodology for each gate: `VERTICAL_BASELINE.md`.

---

## Validated Opportunity Examples

1. Forced Churn Recovery Layer
2. Performance Budget Orchestrator
3. Migration Compatibility Audit
4. Ethical Cancellation Flow
5. Migration Friction Reduction
6. Platform Timing Window Exploitation

Full causal chains and source evidence for each: `VERTICAL_BASELINE.md` §5–6.

---

## Decision

**Decision Date:** 2026-07-05

**Rule:** No additional vertical evaluation until MVP reaches
end-to-end Phase 9 completion (per `MVP_IMPLEMENTATION_PLAN.md`).

This vertical is not revisited, re-scored, or swapped for a
"better-looking" one before a full run has actually executed
Discovery through Compression and produced (or correctly failed to
produce) a recommendation. Any temptation to re-evaluate the vertical
before then is itself a signal to check against this rule, not a
reason to override it.

---

## Success Criteria (unlock conditions)

This vertical remains locked until one of the following occurs:

1. MVP reaches Phase 9 completion.
2. Evidence Yield assumptions are proven false by real pipeline
   output — not by a manual re-check or a hunch, but by Discovery/
   Expansion/CompetitiveAnalysis actually running against this
   vertical and coming back thin or garbage, contradicting
   `VERTICAL_BASELINE.md`'s findings.
3. A critical implementation blocker specific to this vertical is
   discovered — e.g. a data source becomes technically inaccessible
   in a way no other vertical would face.

No other reason is sufficient to reopen vertical selection. In
particular: a stage-specific technical failure (e.g. Discovery cannot
reach a given source due to a scraping/API limitation) is evaluated
first as an implementation problem to fix, not as evidence against the
vertical — it only counts as condition 3 once it's established the
blocker is specific to this vertical's data sources and not a general
Data Pipeline defect that would recur regardless of which vertical was
chosen.
