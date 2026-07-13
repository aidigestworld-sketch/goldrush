// Real fixture. The hypothesis is the same one Hypothesis Sandbox
// synthesized from this project's own live graph data. The candidate
// evidence below is genuinely real (found via research, paraphrased
// per copyright limits, not invented) — chosen specifically because
// one candidate is a real, on-topic-sounding but mechanism-mismatched
// piece of evidence: Loop Subscriptions does market a "voluntary vs
// involuntary churn" framing, but that framing addresses payment-
// failure-driven churn, not the Shop-Pay-card-removal mechanism this
// hypothesis is actually about. This is the hard case the sandbox
// exists to test — not an easy "obviously irrelevant" or "obviously
// supporting" case.
import type { ValidationSandboxInput } from "../validationSandbox";

export const validationInput: ValidationSandboxInput = {
  hypothesis: {
    id: "hyp-001",
    statement:
      "None of the three competitors market a mechanism to distinguish platform-forced (involuntary) subscription cancellations from voluntary ones. Recharge's dunning/payment-recovery tooling addresses failed payments broadly, but nothing in its positioning mentions detecting or differently routing a Shop-Pay-triggered silent cancellation versus a customer who genuinely chose to leave.",
  },
  candidates: [
    {
      // MECHANISM-MISMATCHED, real, on-topic-sounding — the hard case
      id: "candidate-loop-framing",
      sourceUrlOrIdentifier: "https://appstoreresearch.com/blog/shopify-subscription-churn",
      text: `Loop stands out when the problem is explicitly reducing
subscription churn through better diagnosis of voluntary versus
involuntary churn, which maps to how operators should prioritize
retention work. Loop recommends prioritizing involuntary-churn work
when more than 30% of total churn comes from failed payments, and
prioritizing cancellation interventions when 70% or more of churn is
voluntary. The distinction described here is about payment-failure-
driven involuntary churn (declined cards, insufficient funds) versus
a customer actively choosing to cancel — not about a platform
mechanism silently cancelling a subscription when a payment method is
merely removed or updated.`,
    },
    {
      // GENUINELY SUPPORTING — reinforces the underlying industry-wide gap
      id: "candidate-industry-distinction",
      sourceUrlOrIdentifier: "manual-seed://subscription-churn-industry-analysis",
      text: `Industry analysis of Shopify subscription commerce reports
that analysts explicitly distinguish voluntary churn (a customer
choosing to cancel) from involuntary churn (failed payments, forced
platform-side cancellations), noting these require different
retention tooling — most subscription apps' built-in dunning features
are designed around the voluntary-churn case, not the platform-forced
case.`,
    },
    {
      // OBVIOUSLY IRRELEVANT — easy case, tests the model doesn't force a fit
      id: "candidate-irrelevant-pricing",
      sourceUrlOrIdentifier: "manual-seed://loop-subscriptions-marketing",
      text: `Loop's own marketing describes a free tier scaling up to
$399/month, with a 0.75-1.0% transaction fee and explicitly no
per-order flat fee.`,
    },
  ],
};
