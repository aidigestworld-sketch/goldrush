// Real, paraphrased competitor facts already verified during vertical
// research (VERTICAL_BASELINE.md §2) — Recharge, Loop, Bold pricing
// and positioning. Deliberately includes one analyst-commentary line
// (Bold's "reliable but less innovative" characterization) that is
// NOT the competitor's own stated position — a correct
// CompetitiveAnalysis Agent should be able to tell the difference
// between what a competitor says about itself and what a third party
// says about it, or at minimum not present the analyst's opinion as
// the competitor's own "positioning_summary" without distinguishing it.
import type { CompetitiveAnalysisInputDocument } from "../competitiveAnalysisSandbox";

export const competitiveAnalysisInputDocs: CompetitiveAnalysisInputDocument[] = [
  {
    id: "doc-301",
    competitorName: "Recharge",
    sourceType: "competitor_material",
    text: `Recharge's Shopify App Store listing states pricing tiers from
$25 to $499+ per month, plus a transaction fee of 1.0-1.49% and $0.19
per order. The listing describes Recharge as built for growing and
enterprise subscription brands, with dunning and payment-recovery
tooling included at every tier.`,
  },
  {
    id: "doc-302",
    competitorName: "Loop Subscriptions",
    sourceType: "competitor_material",
    text: `Loop's own marketing describes a free tier scaling up to
$399/month, with a 0.75-1.0% transaction fee and explicitly no
per-order flat fee, distinguishing it from competitors that charge
both a percentage and a per-order amount. Loop's site states that more
than 400 brands have migrated from Recharge to Loop.`,
  },
  {
    id: "doc-303",
    competitorName: "Bold Subscriptions",
    sourceType: "competitor_material",
    text: `Bold Subscriptions is priced at a flat $49.99/month plus a
1% transaction fee, with no tiered pricing structure. Separately, an
industry analyst comparison piece characterizes Bold as "reliable but
less innovative" compared to newer entrants — this is the analyst's
own characterization, not language taken from Bold's own listing or
marketing copy.`,
  },
];
