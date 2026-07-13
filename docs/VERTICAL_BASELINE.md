# VERTICAL_BASELINE.md
## Opportunity Engine — Reference Sample for Shopify Subscription & Reorder Apps

**Purpose**: this is a fixed golden sample, established manually before
any agent code exists. Once Discovery, Expansion, CompetitiveAnalysis,
Hypothesis, and Validation are built, their real output on this same
vertical gets compared against what's recorded here — not against an
abstract notion of "good," but against these specific competitors,
these specific complaint sources, and this specific validated
hidden-cause chain. If the pipeline's Hypothesis Agent can't
independently arrive at something resembling the Shop Pay example
below, that's a concrete, checkable regression — not a vague quality
concern.

**Date established**: 2026-07-05
**Method**: manual/non-agent research (web search), per
MVP_IMPLEMENTATION_PLAN.md §4 risk 0 (Evidence Yield Risk) and the
subsequent Hypothesis Stress Test.

---

## 1. Vertical

**Shopify Subscription & Reorder Apps.** Chosen deliberately not as
the largest available Shopify App Store category, but as the one best
suited to stress-test Hypothesis and Validation Agent logic — this
category's problems naturally chain (Problem → Retention → Churn →
Reorder frequency → Cashflow) in a way that produces symptom-vs-cause
gaps, rather than surface-level feature comparisons.

---

## 2. Confirmed Competitors

Verified via public sources (Shopify App Store listings, vendor
pricing pages, third-party comparison content), as of May–July 2026:

| Competitor | Shopify App Store rating / review count | Pricing shape (as published) |
|---|---|---|
| Recharge | 4.8★ / 2,100+ reviews | $25–$499+/mo tiers + 1.0–1.49% + $0.19/order |
| Loop Subscriptions | 4.9★ / 650+ reviews | Free–$399/mo + 0.75–1.0%, no per-order fee |
| Skio (acquired by Recharge, April 2026, $105M) | 5.0★ / 240+ reviews (pre-acquisition) | ~$299–$599/mo + ~1% + $0.20/order |
| Stay AI | 5.0★ / 140+ reviews | $499/mo + 1% + $0.19/order |
| Joy Subscriptions | 4.9★ / 379+ reviews | Free (first 6mo/$1M rev) then 1.5% |
| Seal Subscriptions | not independently confirmed at review-count level | Free–$24.95/mo tiers, transaction-fee-free |
| Bold Subscriptions | not independently confirmed at review-count level | $49.99/mo flat + 1% |
| Appstle | referenced across multiple sources, pricing/reviews not independently pulled | not independently pulled |
| Smartrr | referenced across multiple sources (loyalty+subscription combined) | not independently pulled |
| Ordergroove | referenced across multiple sources (enterprise-tier) | not independently pulled |
| Recurpay | referenced, positioned as flexible/budget alternative | not independently pulled |
| PayWhirl | referenced across multiple sources | not independently pulled |
| Awtomic | referenced, transaction-fee-only positioning | not independently pulled |
| Shopify Subscriptions (native) | free, no paid tiers | free to install |

**Count: 14 confirmed** (clears the 10+ threshold). `RecurrinGO` and
`Propel`, named in the original candidate list, were **not**
independently verified in this pass — do not treat them as confirmed
until a future pass actually locates them.

---

## 3. Known Complaint / Evidence Sources

Distinct source clusters found (relevant to Confidence Agent's
`cluster_id`/`source_authority_tier` weighting — these are genuinely
different origins, not restatements of one thread):

1. **Shopify App Store reviews** (per-app, individually authored by
   merchants — e.g. Skio's 240+ reviews) — high authority, high
   independence within the cluster (many distinct reviewers).
2. **Shopify Community forums** (community.shopify.com) — source of
   the Shop Pay silent-cancellation reports (§4).
3. **Third-party comparison/analyst blogs** (loopwork.co,
   appstoreresearch.com, kaspianfuad.com, evolveamz.com,
   digitalheroes.co.in, zectox.is-a.dev) — **caveat**: several of
   these are vendor-published (e.g. loopwork.co is Loop's own blog)
   and must be tagged with a lower `source_authority_tier` for
   competitor-characterizing claims specifically — vendor self-comparison
   content is not neutral evidence about competitors, even when
   pricing figures cited from it are independently verifiable.
4. **Developer/technical blogs** (kaspianfuad.com's Liquid/INP/CLS
   analysis) — a distinct cluster from the merchant-facing comparison
   content above; this is where the two most technically specific
   hidden-cause hypotheses (performance-budget defaults, Liquid
   migration-audit gap) originated.
5. **Vendor's own product marketing copy** (e.g. Skio characterizing
   Recharge's portal as "clunky") — explicitly **not** independent
   evidence; flagged as a deliberate test case for
   `source_authority_tier` weighting (§5).

---

## 4. Evidence Yield Gate — Result: **PASS**

| Dimension | Threshold | Result |
|---|---|---|
| Competitor volume | 10+ | 14 confirmed |
| Review volume | 100+ | 3,500+ across 5 named apps alone |
| Pricing pages | — | Highly diverse business models (flat, tiered, hybrid %+per-order, free-forever) |
| Complaint sources | multiple independent | 5 distinct clusters (§3) |
| Cluster diversity (not just volume) | multiple independent clusters | Confirmed — merchant reviews, forums, analyst blogs, and dev-technical blogs are genuinely distinct origins, not restatements of one source |

---

## 5. Hypothesis Stress Test — Result: 6 / 22 (≈27%) produced non-trivial hypotheses

Threshold for passing (per architect's own criterion): 5–7 out of 20.
**Result exceeds threshold.**

The six validated hypotheses, for future comparison against real
Hypothesis Agent output on this vertical:

1. **Migration-friction-reduction layer** — brands stay with an
   incumbent they want to leave because switching costs $10–30K and
   60–90 days; white space in reducing that friction specifically,
   not in subscription management itself.
2. **Shop-Pay-forced-churn cohort** — see §6, the reference example.
3. **Performance-budget-aware lazy-loading defaults** — no vendor
   designs against the real merchant app-stack (reviews+popup+chat+
   subscription on one PDP); sourced from a dev-technical cluster,
   distinct from the merchant-facing comparison cluster.
4. **Ethical/transparent cancellation-flow design** — positioned
   against aggressive save-offer dark patterns that operators
   privately describe as "manipulative," which no vendor's own
   marketing acknowledges.
5. **Compliance-deadline timing window** — Shopify's Checkout
   Extensibility mandate for Plus stores creates a time-boxed forced
   re-evaluation window, mapping directly onto this system's own
   `timing_score` scoring dimension.
6. **Migration compatibility-audit layer for custom Liquid** —
   existing migration tooling handles subscriber/payment data
   thoroughly but not custom theme-code dependencies broken by
   changing `selling_plan_group` IDs.

Sixteen other candidate complaints were evaluated and judged either
trivial (too generic to imply a cause), already commercially exploited
by an existing competitor's stated positioning, or duplicative of one
of the six above — full walkthrough is in this conversation's history,
not repeated here to keep this baseline document to its comparison
role rather than a research log.

---

## 6. Validated Hidden-Cause Example (reference exemplar)

This is the single example every future Hypothesis Agent run on this
vertical should be checked against — if the built pipeline can't
surface something resembling this chain, that's a concrete regression:

```
Complaint (surface-level, as merchants typically report it):
  "Customers cancel their subscriptions."

Evidence (Shopify Community forum reports):
  Subscribers on Shop Pay have their subscription silently cancelled
  when they remove or update their payment card. Shopify frames this
  as a consumer-protection measure, not a merchant-facing feature.

Candidate Cause (the non-obvious part):
  This is NOT voluntary churn, poor retention offers, or price
  sensitivity — it is a platform-level side effect the merchant has
  no visibility into. The customer frequently does not realize the
  subscription ended until a delivery is missed.

Supporting Evidence:
  - Shopify has adjusted this behavior over time but it remains at
    Shop Pay's discretion, not a guaranteed merchant-facing control.
  - Industry analysis explicitly distinguishes "voluntary vs
    involuntary churn" as requiring different diagnosis and different
    tooling — most subscription apps' dunning/retention features are
    built around the voluntary-churn assumption.

Hypothesis:
  White space exists for a distinct win-back/monitoring layer that
  treats Shop-Pay-forced cancellations as a separate cohort from
  voluntary cancellations — current dunning tools largely conflate the
  two, treating a silent platform-side cancellation the same as a
  customer who actively chose to leave.
```

---

## 7. How to Use This Document

- When Discovery/Expansion/CompetitiveAnalysis first run against this
  vertical, compare their extracted competitor list against §2 —
  finding meaningfully fewer than 14, or missing the major names
  entirely, is a signal the extraction layer is underperforming, not
  that the vertical is thin (§4 already established it isn't).
- When Hypothesis Agent runs, check whether any of its output resembles
  the six hypotheses in §5, and specifically whether it can
  reconstruct something like §6's causal chain rather than stopping at
  the surface-level complaint. Failing to ever surface a
  symptom-vs-cause hypothesis on this vertical — which manual research
  showed clearly contains them — is a real finding about the
  Hypothesis Agent, not about the data.
- When Validation/Confidence Agents run, check specifically how they
  handle the vendor-self-promotion source flagged in §3 item 5 —
  this baseline was deliberately left containing that trap so the
  pipeline's `source_authority_tier` handling has something concrete
  to be tested against.

---

## 8. Phase 4 Live Confirmation (2026-07-05 — real NIM run, not a mock)

The manual research and mock-tested sandbox above have now been
confirmed against a real, live model run — not just a hand-verified
exemplar or a hardcoded "good" mock response. This is the first time
this vertical's central bet was actually tested end-to-end.

**Setup**: same real evidence as §6 (Shop Pay card-removal /
Shopifreaks reporting / May 2026 policy), run through the live
Expansion Agent against NIM three times — low-cost tier with the
original prompt, mid-tier with the original prompt, mid-tier with a
prompt extended to require gap/missing-capability framing (not just
naming the mechanism). Full comparison lives in this project's chat
history; the result that matters is recorded here.

**Result**: the third run produced, verbatim:

> "No way to distinguish between intentional and unintentional
> subscription cancellations due to payment method changes"

This is the real-model equivalent of §6's hand-written exemplar
hypothesis ("a distinct win-back/monitoring layer... current dunning
tools largely conflate the two") — arrived at independently by an
actual live model call, not authored by hand as a target to hit. The
low-cost tier and the original (pre-fix) prompt both stopped at naming
the mechanism ("Automatic cancellation... when removing payment
card" / "Involuntary Subscription Cancellations due to Card Removal")
— neither reached gap framing. Both the model-tier change (low-cost →
mid-tier) and the prompt change (require gap framing explicitly) were
necessary; tier alone got partway (picked up "involuntary" as a
concept) but not to the missing-capability framing itself.

**Trade-off accepted**: the stricter prompt caused the model to drop
one of the three original mechanism-level candidates (doc-101's
card-update-difficulty complaint) rather than emit a mechanism-only
label for it. Evidence isn't lost — the underlying Evidence row is
still citable — only that no Problem was synthesized from it in this
pass. Decided to keep this trade for MVP: fewer, correctly-framed
Problems are worth more downstream (to Composition/Hypothesis) than
higher volume padded with mechanism-only noise Filtering would have to
catch anyway.

**Carries forward**: the SYMPTOM → MECHANISM → GAP prompt scaffolding
that made this work belongs in Hypothesis Agent's eventual prompt too
(AI_AGENTS.md §5) — Hypothesis's whole job is this same kind of
causal synthesis one level up the graph, and this is now empirical
evidence for what actually elicits it from a real model, not just a
design guess.
