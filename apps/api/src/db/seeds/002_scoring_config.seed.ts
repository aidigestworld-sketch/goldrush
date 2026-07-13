// Seeds scoring_config version 1 for the locked MVP vertical
// (MVP_VERTICAL.md: "Shopify Subscription & Reorder Apps",
// vertical key "shopify_subscriptions" as used throughout
// AGENT_EXECUTION_DAG.md / DATABASE_SCHEMA.md smoke tests).
//
// These are the untuned heuristic weights MVP_IMPLEMENTATION_PLAN.md
// §1 explicitly says v1 ships with — no outcome data exists yet to
// tune against. quality_weight/founder_fit_weight use the 0.7/0.3
// split flagged as an unvalidated placeholder in OPPORTUNITY_ENGINE.md
// §8/§13.3 — written explicitly here rather than relying on the
// column default, so this seed stays the single source of what
// version 1 actually contains even if the column default ever changes.
import { prisma } from "../client";

const VERTICAL = "shopify_subscriptions";

export async function seedScoringConfigV1(): Promise<void> {
  await prisma.scoringConfig.upsert({
    where: { version_vertical: { version: 1, vertical: VERTICAL } },
    create: {
      version: 1,
      vertical: VERTICAL,
      w1Demand: 0.2,
      w2Hypothesis: 0.2,
      w3Margin: 0.15,
      w4Feasibility: 0.15,
      w5Distribution: 0.15,
      w6Timing: 0.15,
      qualityWeight: 0.7,
      founderFitWeight: 0.3,
    },
    update: {
      w1Demand: 0.2,
      w2Hypothesis: 0.2,
      w3Margin: 0.15,
      w4Feasibility: 0.15,
      w5Distribution: 0.15,
      w6Timing: 0.15,
      qualityWeight: 0.7,
      founderFitWeight: 0.3,
    },
  });
}

if (require.main === module) {
  seedScoringConfigV1()
    .then(() => {
      console.log(`Seeded scoring_config v1 for vertical "${VERTICAL}"`);
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
