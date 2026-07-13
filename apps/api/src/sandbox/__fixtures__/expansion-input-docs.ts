// Real, paraphrased (not verbatim-quoted, per copyright limits)
// content from actual sources found during vertical research:
// community.shopify.com/t/shop-pay-subscription-issues/408285,
// shopifreaks.com's reporting on the Shop Pay silent-cancellation
// bug, and Shopify's own May 2026 payment-method-revocation policy
// change. This is genuinely richer than what VERTICAL_BASELINE.md §6
// originally captured — the May 2026 policy adds a second, related
// hidden-cause angle (a 24-hour reinstatement window after
// cancellation) that wasn't in the original research pass.
import type { ExpansionInputDocument } from "../expansionSandbox";

export const expansionInputDocs: ExpansionInputDocument[] = [
  {
    id: "doc-101",
    sourceType: "review_complaint",
    text: `A merchant posted on the Shopify Community forum describing
persistent frustration with Shop Pay's handling of subscriptions: when
a customer's card on file expires, updating it is unusually difficult
compared to other checkout flows, and Shopify's own support could not
resolve it after months. The merchant states this is costing them a
large number of customers and consuming significant staff time on
support calls, though no exact customer count is given in the post.`,
  },
  {
    id: "doc-102",
    sourceType: "review_complaint",
    text: `Industry reporting (Shopifreaks) confirmed Shopify quietly
patched a bug where removing a payment card from Shop Pay caused every
active subscription tied to that card to be cancelled automatically,
across every merchant on the platform, with no warning to merchants
and no signal that the customer intended to cancel. The report states
this effectively disguised involuntary churn as ordinary churn,
because merchants had no way to tell a customer who wanted to leave
apart from one who had simply changed their card. The reporting
describes this as affecting many merchants broadly, given Shop Pay's
default role at checkout, though it does not give a precise count of
affected subscriptions.`,
  },
  {
    id: "doc-103",
    sourceType: "review_complaint",
    text: `Shopify announced a related policy change effective May 4,
2026: once a subscription is cancelled and the customer has no other
active subscriptions, their saved payment method is automatically
revoked. Merchants can reinstate the original payment method within a
24-hour window if the cancellation was accidental; after 24 hours, the
customer must re-enter payment details to start a new subscription.
Shopify frames this as a fraud-prevention measure.`,
  },
];
