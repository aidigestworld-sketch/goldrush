// STAND-IN, not a permanent fixture — same pattern as
// 003_discovery_evidence_seed.ts, and same reason: Phase 2's Data
// Pipeline has never actually landed real review_complaint rows in
// Postgres (the live reviews connector has never been run against
// the real network within this project), so Expansion has nothing
// real to read yet.
//
// This is the decision made at the Phase 4 Step 6 checkpoint: hand-
// seed from the already-validated fixture (Option 1) rather than
// standing up the live connector + IngestPipeline runner right now
// (Option 2, still worth doing later — this does not replace it).
//
// Content is IDENTICAL to sandbox/__fixtures__/expansion-input-docs.ts
// (real, paraphrased Shop Pay forced-cancellation content, already
// used to validate the Expansion Sandbox's grounding-check logic
// against a mock LLM). Running the real Expansion Agent against this
// same text via a LIVE NIM call is a genuinely different, valuable
// test even though the input text is unchanged — it answers whether
// the hand-written "good" mock response generalizes to what an actual
// model produces, not just whether the harness's checks work.
import { prisma } from "../client";

export async function seedExpansionEvidence(): Promise<{ count: number }> {
  const rows = [
    {
      sourceUrlOrIdentifier: "manual-seed://shopify-community-shop-pay-subscription-issues",
      sourceType: "review_complaint",
      sourceAuthorityTier: "forum_post" as const,
      extractionMethod: "html_parse" as const,
      extractionConfidence: 0.75,
      extractedFact: `A merchant posted on the Shopify Community forum describing
persistent frustration with Shop Pay's handling of subscriptions: when
a customer's card on file expires, updating it is unusually difficult
compared to other checkout flows, and Shopify's own support could not
resolve it after months. The merchant states this is costing them a
large number of customers and consuming significant staff time on
support calls, though no exact customer count is given in the post.`,
      fetchedAt: new Date(),
      freshness: 0.7,
    },
    {
      sourceUrlOrIdentifier: "manual-seed://shopifreaks-shop-pay-silent-cancellation-bug",
      sourceType: "review_complaint",
      sourceAuthorityTier: "industry_report" as const, // Shopifreaks is industry reporting, not a raw forum post — higher tier than doc-101
      extractionMethod: "html_parse" as const,
      extractionConfidence: 0.85,
      extractedFact: `Industry reporting (Shopifreaks) confirmed Shopify quietly
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
      fetchedAt: new Date(),
      freshness: 0.8,
    },
    {
      sourceUrlOrIdentifier: "manual-seed://shopify-payment-method-revocation-policy-may-2026",
      sourceType: "review_complaint",
      sourceAuthorityTier: "competitor_self_stated" as const, // this is Shopify's own policy announcement
      extractionMethod: "html_parse" as const,
      extractionConfidence: 0.9,
      extractedFact: `Shopify announced a related policy change effective May 4,
2026: once a subscription is cancelled and the customer has no other
active subscriptions, their saved payment method is automatically
revoked. Merchants can reinstate the original payment method within a
24-hour window if the cancellation was accidental; after 24 hours, the
customer must re-enter payment details to start a new subscription.
Shopify frames this as a fraud-prevention measure.`,
      fetchedAt: new Date(),
      freshness: 0.85,
    },
  ];

  const result = await prisma.evidence.createMany({
    data: rows.map((r) => ({ ...r, verificationStatus: "unverified", status: "active" })),
  });
  return { count: result.count };
}

if (require.main === module) {
  seedExpansionEvidence()
    .then((r) => {
      console.log(`Seeded ${r.count} Expansion-eligible (review_complaint) evidence rows`);
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
