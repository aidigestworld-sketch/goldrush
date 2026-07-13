// Real facts, not invented — pulled from actual research done earlier
// in this project (VERTICAL_BASELINE.md), reshaped as the kind of
// industry_report/marketplace-type documents Discovery would actually
// receive from Data Pipeline once Phase 2's connectors cover this
// source_type category (not yet built — Phase 2 so far only has
// review_complaint and competitor_material connectors).
import type { DiscoveryInputDocument } from "../discoverySandbox";

export const discoveryInputDocs: DiscoveryInputDocument[] = [
  {
    id: "doc-001",
    sourceType: "marketplace",
    text: `The Shopify App Store lists more than 20 subscription and recurring-order
apps as of mid-2026, spanning flat-fee tools (Bold Subscriptions at
$49.99/mo), free-tier options (native Shopify Subscriptions, Loop's
free tier, Seal's free tier), and enterprise-oriented platforms
charging $299-599/mo plus 0.75-1.49% of subscription revenue
(Recharge, Skio, Stay AI).`,
  },
  {
    id: "doc-002",
    sourceType: "financial_signal",
    text: `In April 2026, Recharge acquired competitor Skio for $105 million,
consolidating two of the largest players in the Shopify subscription-app
market. Skio's Shopify App Store listing showed 240+ reviews and a
5.0-star rating prior to the acquisition.`,
  },
  {
    id: "doc-003",
    sourceType: "industry_report",
    text: `Industry analysis of Shopify subscription commerce reports average
monthly churn near 5%, compounding to roughly 46% annual churn if
unaddressed. Analysts explicitly distinguish voluntary churn (a customer
choosing to cancel) from involuntary churn (failed payments, forced
platform-side cancellations), noting these require different retention
tooling — most subscription apps' built-in dunning features are designed
around the voluntary-churn case.`,
  },
];
