// Real fixture built from this project's OWN live pipeline output —
// not new research. The Problem is Expansion's actual gap-framed
// output (VERTICAL_BASELINE.md §8); the ExistingSolutions and their
// positioning are CompetitiveAnalysis's actual live extraction
// (same run reported in this project's chat history). This is the
// most "real" fixture in the whole sandbox suite — every field here
// is copied from an actual database row this project's own agents
// produced, not authored by hand or pulled from external research.
import type { HypothesisSandboxInput } from "../hypothesisSandbox";

export const hypothesisInput: HypothesisSandboxInput = {
  problem: {
    id: "173a0c23-e41d-4c32-af0c-d484c9add01a",
    label: "No way to distinguish between intentional and unintentional subscription cancellations due to payment method changes",
    problemMaturity: "recognized_unsolved",
    currentWorkaroundDescription:
      "Shopify allows reinstating the original payment method within a 24-hour window if the cancellation was accidental — a Shopify policy, not a merchant-side fix.",
  },
  existingSolutions: [
    {
      id: "08902600-d4e9-45c4-bf8f-773277500c27",
      label: "Recharge",
      positioningSummary: "Built for growing and enterprise subscription brands with dunning and payment-recovery tooling",
      pricingSummary: "Pricing tiers from $25 to $499+ per month, plus a transaction fee of 1.0-1.49% and $0.19 per order",
    },
    {
      id: "46d3dd86-8315-44a7-acdf-98268ebc6f8c",
      label: "Loop Subscriptions",
      positioningSummary: "Offers a free tier scaling up to $399/month with no per-order flat fee",
      pricingSummary: "Free tier scaling up to $399/month with 0.75-1.0% transaction fee",
    },
    {
      id: "27d0cfe3-f490-4d4e-abd0-9a6c5d23ecb7",
      label: "Bold Subscriptions",
      positioningSummary: "Priced at a flat $49.99/month plus 1% transaction fee",
      pricingSummary: "Flat $49.99/month plus 1% transaction fee",
    },
  ],
  evidence: [
    {
      id: "fe991ccf-a812-4bb2-8762-34614d58528c",
      sourceUrlOrIdentifier: "manual-seed://recharge-app-store-listing",
      text: `Recharge's Shopify App Store listing states pricing tiers from
$25 to $499+ per month, plus a transaction fee of 1.0-1.49% and $0.19
per order. The listing describes Recharge as built for growing and
enterprise subscription brands, with dunning and payment-recovery
tooling included at every tier.`,
    },
    {
      id: "40044b8c-9803-441a-9da1-3534365ccd13",
      sourceUrlOrIdentifier: "manual-seed://loop-subscriptions-marketing",
      text: `Loop's own marketing describes a free tier scaling up to
$399/month, with a 0.75-1.0% transaction fee and explicitly no
per-order flat fee, distinguishing it from competitors that charge
both a percentage and a per-order amount. Loop's site states that more
than 400 brands have migrated from Recharge to Loop.`,
    },
    {
      id: "d84beda8-6874-4655-bd48-4d59726b190b",
      sourceUrlOrIdentifier: "manual-seed://bold-subscriptions-listing-and-analyst-review",
      text: `Bold Subscriptions is priced at a flat $49.99/month plus a
1% transaction fee, with no tiered pricing structure.`,
    },
  ],
};
