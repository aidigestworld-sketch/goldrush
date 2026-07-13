// Real fixture, continuing the same hypothesis thread. Deliberately
// includes a genuine duplicate-source case: two evidence_against
// items both come from the same appstoreresearch.com article (two
// different paragraphs of it) — this is the actual "five forum posts
// quoting one thread" problem this whole project has been guarding
// against since its earliest architecture discussions.
//
// Under V8, the model no longer reports distinct-source counts — the
// backend computes them and injects them as GIVEN FACTS. The fixture
// therefore includes a backendFacts field with the mechanically-derived
// values: distinct supporting sources = 2 (two distinct URLs), distinct
// contradicting sources = 1 (two items share appstoreresearch.com),
// highest supporting tier = industry_report (both items are), highest
// contradicting tier = forum_post (both items are). The fixture no
// longer tests "does the model count correctly" — that's not the
// model's job anymore. It now tests "does the model correctly identify
// which items directly answer the hypothesis question" and "does its
// score fall in the band its own answers_question map implies."
import type { ConfidenceSandboxInput } from "../confidenceSandbox";

export const confidenceInput: ConfidenceSandboxInput = {
  hypothesisStatement:
    "None of the three competitors market a mechanism to distinguish platform-forced (involuntary) subscription cancellations from voluntary ones. Recharge's dunning/payment-recovery tooling addresses failed payments broadly, but nothing in its positioning mentions detecting or differently routing a Shop-Pay-triggered silent cancellation versus a customer who genuinely chose to leave.",
  evidenceFor: [
    {
      id: "ev-industry-distinction",
      sourceUrlOrIdentifier: "manual-seed://subscription-churn-industry-analysis",
      sourceAuthorityTier: "industry_report",
      text: `Industry analysis of Shopify subscription commerce reports
that analysts explicitly distinguish voluntary churn (a customer
choosing to cancel) from involuntary churn (failed payments, forced
platform-side cancellations), noting these require different
retention tooling — most subscription apps' built-in dunning features
are designed around the voluntary-churn case, not the platform-forced
case.`,
    },
    {
      id: "ev-shopifreaks-bug",
      sourceUrlOrIdentifier: "manual-seed://shopifreaks-shop-pay-silent-cancellation-bug",
      sourceAuthorityTier: "industry_report",
      text: `Industry reporting (Shopifreaks) confirmed Shopify quietly
patched a bug where removing a payment card from Shop Pay caused every
active subscription tied to that card to be cancelled automatically,
with no warning to merchants and no signal that the customer intended
to cancel — effectively disguising involuntary churn as ordinary
churn, because merchants had no way to tell a customer who wanted to
leave apart from one who had simply changed their card.`,
    },
  ],
  evidenceAgainst: [
    {
      // Duplicate-source pair, item 1 of 2
      id: "ev-loop-framing-para1",
      sourceUrlOrIdentifier: "https://appstoreresearch.com/blog/shopify-subscription-churn",
      sourceAuthorityTier: "forum_post", // lower tier — third-party analyst blog, per this project's own established caution about vendor/analyst-blog bias
      text: `Loop stands out when the problem is explicitly reducing
subscription churn through better diagnosis of voluntary versus
involuntary churn, which maps to how operators should prioritize
retention work. Loop recommends prioritizing involuntary-churn work
when more than 30% of total churn comes from failed payments, and
prioritizing cancellation interventions when 70% or more of churn is
voluntary.`,
    },
    {
      // Duplicate-source pair, item 2 of 2 — SAME URL as above, different paragraph
      id: "ev-loop-framing-para2",
      sourceUrlOrIdentifier: "https://appstoreresearch.com/blog/shopify-subscription-churn",
      sourceAuthorityTier: "forum_post",
      text: `When teams interview merchants who recently migrated from
Recharge, evaluated Skio, or adopted Loop for cancellation flows, the
insights tend to be practical — which portal changes reduced support
burden, which dunning flows were too opaque, which save offers felt
manipulative.`,
    },
  ],
  backendFacts: {
    distinctSupportingSources: 2,
    distinctContradictingSources: 1,
    highestSupportingTier: "industry_report",
    highestContradictingTier: "forum_post",
  },
};
