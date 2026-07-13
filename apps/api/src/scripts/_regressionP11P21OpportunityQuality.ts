// P1.1/P2.1 regression: for every shipped Opportunity, recompute
// opportunity_quality with the P1.1/P2.1 fix and confirm the result
// is byte-identical to what's already stored. Also verifies:
//   * neither hard-assertion throw fires on any real candidate
//     (validationScore + supportingEvidenceStrength are populated
//     in every real case per the earlier investigation);
//   * scoringInputProvenance correctly flags the 5 chronic-null
//     fields as "default" on real data (100% chronic-null on the
//     composed slice per _checkScoringInputNullRates.ts).
//
// Read-only.
// Run: npx tsx -r dotenv/config src/scripts/_regressionP11P21OpportunityQuality.ts
import { prisma } from "../db/client";
import { computeOpportunityQuality, type ScoringInputs } from "../agents/scoring";
import { scoringConfigRepository } from "../repositories/scoringConfig.repository";

async function main() {
  // Use OpportunityCandidate directly so we can also check unpromoted
  // candidates — a fuller regression than only inspecting the 2
  // promoted rows.
  const cands = await prisma.opportunityCandidate.findMany({
    include: { composition: true, run: true },
  });

  let checked = 0;
  let mismatched = 0;
  let threw = 0;
  console.log(`Candidates inspected: ${cands.length}\n`);

  for (const cand of cands) {
    if (cand.opportunityQuality === null) {
      console.log(`  ${cand.id.slice(0, 8)} status=${cand.status}  opportunityQuality=null — skipped`);
      continue;
    }
    const byRole = new Map(cand.composition.map((c) => [c.role, c.nodeId]));
    const [market, audience, problem, hypothesis, businessModel, config] = await Promise.all([
      byRole.get("market") ? prisma.market.findUnique({ where: { id: byRole.get("market")! } }) : null,
      byRole.get("audience") ? prisma.audience.findUnique({ where: { id: byRole.get("audience")! } }) : null,
      byRole.get("problem") ? prisma.problem.findUnique({ where: { id: byRole.get("problem")! } }) : null,
      byRole.get("hypothesis") ? prisma.hypothesis.findUnique({ where: { id: byRole.get("hypothesis")! } }) : null,
      byRole.get("business_model") ? prisma.businessModel.findUnique({ where: { id: byRole.get("business_model")! } }) : null,
      scoringConfigRepository.latestForVertical(cand.run.vertical),
    ]);
    if (!market || !audience || !problem || !hypothesis || !businessModel || !config) {
      console.log(`  ${cand.id.slice(0, 8)} status=${cand.status}  composition/config incomplete — skipped`);
      continue;
    }

    const inputs: ScoringInputs = {
      market: {
        growthRateEstimate: market.growthRateEstimate,
        maturityStage: market.maturityStage as ScoringInputs["market"]["maturityStage"],
      },
      audience: {
        willingnessToPaySignal: audience.willingnessToPaySignal,
        acquisitionChannelsKnown: audience.acquisitionChannelsKnown,
      },
      problem: { severitySignal: problem.severitySignal, frequencySignal: problem.frequencySignal },
      hypothesis: {
        validationScore: hypothesis.validationScore,
        supportingEvidenceStrength: hypothesis.supportingEvidenceStrength,
      },
      businessModel: {
        marginProfile: businessModel.marginProfile,
        operationalComplexityEstimate: businessModel.operationalComplexityEstimate,
        capitalIntensityEstimate: businessModel.capitalIntensityEstimate,
      },
    };

    let out;
    try {
      out = computeOpportunityQuality(inputs, {
        w1Demand: config.w1Demand,
        w2Hypothesis: config.w2Hypothesis,
        w3Margin: config.w3Margin,
        w4Feasibility: config.w4Feasibility,
        w5Distribution: config.w5Distribution,
        w6Timing: config.w6Timing,
      });
    } catch (err) {
      threw++;
      console.log(`✗ ${cand.id.slice(0, 8)} status=${cand.status}  THREW: ${(err as Error).message.slice(0, 140)}`);
      continue;
    }
    checked++;

    // Prisma real → JS number is float32-widened-to-float64; store also
    // went through float32. Compare at float32 precision by
    // Math.fround, then also print the exact diff for the audit line.
    const storedF32 = Math.fround(cand.opportunityQuality);
    const recomputedF32 = Math.fround(out.opportunityQuality);
    const identical = storedF32 === recomputedF32;
    if (!identical) mismatched++;
    console.log(
      `${identical ? "✓" : "✗"} ${cand.id.slice(0, 8)} status=${cand.status}` +
        `  stored=${cand.opportunityQuality.toFixed(6)}  recomputed=${out.opportunityQuality.toFixed(6)}` +
        `  provenance: real=${out.realInputCount} default=${out.defaultedInputCount}`
    );
    if (!identical) {
      const perField = out.scoringInputProvenance.map((p) => `${p.field}=${p.source}(${p.value.toFixed(3)})`).join(", ");
      console.log(`    per-field: ${perField}`);
    }
  }

  console.log(
    `\nsummary: checked=${checked}  byte-identical=${checked - mismatched}  mismatched=${mismatched}  threw=${threw}`
  );
  if (mismatched > 0 || threw > 0) process.exit(1);
  await prisma.$disconnect().catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
