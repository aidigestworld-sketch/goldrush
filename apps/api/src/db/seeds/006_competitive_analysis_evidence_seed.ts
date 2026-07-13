// STAND-IN, not a permanent fixture — same pattern as seeds 003/004.
// The live shopifyAppStoreListing.connector.ts has never been run
// against the real network within this project. This unblocks a real
// CompetitiveAnalysis run now, using the same genuine, paraphrased
// competitor facts already validated in
// sandbox/__fixtures__/competitive-analysis-input-docs.ts (Recharge,
// Loop Subscriptions, Bold Subscriptions — including the deliberate
// analyst-vs-competitor-stated attribution trap for Bold).
//
// Unlike seeds 003/004 (createMany), this uses individual creates so
// the returned ids can be grouped by competitor name — the live
// CompetitiveAnalysis agent's signature needs a
// Map<competitorName, evidenceId[]>, not just a flat evidence list.
import { prisma } from "../client";

export interface SeededCompetitiveEvidence {
  competitorNamesToEvidenceIds: Map<string, string[]>;
}

export async function seedCompetitiveAnalysisEvidence(): Promise<SeededCompetitiveEvidence> {
  const recharge = await prisma.evidence.create({
    data: {
      sourceUrlOrIdentifier: "manual-seed://recharge-app-store-listing",
      sourceType: "competitor_material",
      sourceAuthorityTier: "competitor_self_stated",
      extractionMethod: "html_parse",
      extractionConfidence: 0.85,
      extractedFact: `Recharge's Shopify App Store listing states pricing tiers from
$25 to $499+ per month, plus a transaction fee of 1.0-1.49% and $0.19
per order. The listing describes Recharge as built for growing and
enterprise subscription brands, with dunning and payment-recovery
tooling included at every tier.`,
      fetchedAt: new Date(),
      freshness: 0.75,
      verificationStatus: "unverified",
      status: "active",
    },
  });

  const loop = await prisma.evidence.create({
    data: {
      sourceUrlOrIdentifier: "manual-seed://loop-subscriptions-marketing",
      sourceType: "competitor_material",
      sourceAuthorityTier: "competitor_self_stated",
      extractionMethod: "html_parse",
      extractionConfidence: 0.85,
      extractedFact: `Loop's own marketing describes a free tier scaling up to
$399/month, with a 0.75-1.0% transaction fee and explicitly no
per-order flat fee, distinguishing it from competitors that charge
both a percentage and a per-order amount. Loop's site states that more
than 400 brands have migrated from Recharge to Loop.`,
      fetchedAt: new Date(),
      freshness: 0.75,
      verificationStatus: "unverified",
      status: "active",
    },
  });

  const bold = await prisma.evidence.create({
    data: {
      sourceUrlOrIdentifier: "manual-seed://bold-subscriptions-listing-and-analyst-review",
      sourceType: "competitor_material",
      sourceAuthorityTier: "competitor_self_stated", // NOTE: the extractedFact below deliberately bundles a self-stated
      // fact with a third-party analyst opinion in the same row — this is the same attribution
      // trap competitiveAnalysisSandbox.test.ts already exercises against a mock. Real test:
      // does the LIVE agent correctly flag the analyst line as non-competitor-stated?
      extractionMethod: "html_parse",
      extractionConfidence: 0.8,
      extractedFact: `Bold Subscriptions is priced at a flat $49.99/month plus a
1% transaction fee, with no tiered pricing structure. Separately, an
industry analyst comparison piece characterizes Bold as "reliable but
less innovative" compared to newer entrants — this is the analyst's
own characterization, not language taken from Bold's own listing or
marketing copy.`,
      fetchedAt: new Date(),
      freshness: 0.7,
      verificationStatus: "unverified",
      status: "active",
    },
  });

  const competitorNamesToEvidenceIds = new Map<string, string[]>([
    ["Recharge", [recharge.id]],
    ["Loop Subscriptions", [loop.id]],
    ["Bold Subscriptions", [bold.id]],
  ]);

  return { competitorNamesToEvidenceIds };
}

if (require.main === module) {
  seedCompetitiveAnalysisEvidence()
    .then((r) => {
      console.log("Seeded competitor_material evidence for:", [...r.competitorNamesToEvidenceIds.keys()].join(", "));
      for (const [name, ids] of r.competitorNamesToEvidenceIds) {
        console.log(`  ${name}: ${ids.join(", ")}`);
      }
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
