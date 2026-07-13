// STAND-IN, not a permanent fixture: seeds real Discovery-eligible
// Evidence rows using the same genuine, verified facts already used
// in sandbox/__fixtures__/discovery-input-docs.ts.
//
// NOTE: seeds 3 of Discovery's 4 allowed source types
// (marketplace, financial_signal, industry_report) — search_signal
// is deliberately omitted, since no genuine search-volume/demand-trend
// fact was gathered during this project's research (fabricating one
// would defeat the point of every other real-fact-only fixture in
// this codebase). Discovery still runs correctly on 3 types; a real
// search_signal source is a separate, still-open gap, same as the
// marketplace/industry_report connector itself.
//
// WHY THIS EXISTS: Phase 2's Data Pipeline only has connectors for
// review_complaint and competitor_material. Nothing ingests the
// source types Discovery Agent actually needs. This unblocks testing
// Discovery for real against real Postgres NOW, but a proper
// marketplace/industry_report/search_signal connector is still a
// real, open Phase 2 gap — do not treat this seed as a substitute for
// building one.
import { prisma } from "../client";

export async function seedDiscoveryEvidence(): Promise<{ count: number }> {
  const rows = [
    {
      sourceUrlOrIdentifier: "manual-seed://shopify-app-store-marketplace-overview",
      sourceType: "marketplace",
      sourceAuthorityTier: "industry_report" as const,
      extractionMethod: "structured_api" as const, // this fact came from a structured directory count, not free-text parsing
      extractionConfidence: 0.9,
      extractedFact:
        "The Shopify App Store lists more than 20 subscription and recurring-order apps as of mid-2026, spanning flat-fee tools (Bold Subscriptions at $49.99/mo), free-tier options (native Shopify Subscriptions, Loop's free tier, Seal's free tier), and enterprise-oriented platforms charging $299-599/mo plus 0.75-1.49% of subscription revenue (Recharge, Skio, Stay AI).",
      fetchedAt: new Date(),
      freshness: 0.8,
    },
    {
      sourceUrlOrIdentifier: "manual-seed://recharge-skio-acquisition-april-2026",
      sourceType: "financial_signal",
      sourceAuthorityTier: "industry_report" as const,
      extractionMethod: "html_parse" as const,
      extractionConfidence: 0.95,
      extractedFact:
        "In April 2026, Recharge acquired competitor Skio for $105 million, consolidating two of the largest players in the Shopify subscription-app market. Skio's Shopify App Store listing showed 240+ reviews and a 5.0-star rating prior to the acquisition.",
      fetchedAt: new Date(),
      freshness: 0.85,
    },
    {
      sourceUrlOrIdentifier: "manual-seed://subscription-churn-industry-analysis",
      sourceType: "industry_report",
      sourceAuthorityTier: "industry_report" as const,
      extractionMethod: "html_parse" as const,
      extractionConfidence: 0.85,
      extractedFact:
        "Industry analysis of Shopify subscription commerce reports average monthly churn near 5%, compounding to roughly 46% annual churn if unaddressed. Analysts explicitly distinguish voluntary churn (a customer choosing to cancel) from involuntary churn (failed payments, forced platform-side cancellations), noting these require different retention tooling — most subscription apps' built-in dunning features are designed around the voluntary-churn case.",
      fetchedAt: new Date(),
      freshness: 0.75,
    },
  ];

  const result = await prisma.evidence.createMany({
    data: rows.map((r) => ({ ...r, verificationStatus: "unverified", status: "active" })),
  });
  return { count: result.count };
}

if (require.main === module) {
  seedDiscoveryEvidence()
    .then((r) => {
      console.log(`Seeded ${r.count} Discovery-eligible evidence rows`);
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
