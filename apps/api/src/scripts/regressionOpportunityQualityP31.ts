// P3.1 regression check: for every promoted Opportunity's underlying
// candidate, recompute opportunity_quality with the new grounded
// supportingEvidenceStrength (evidenceStrength.ts) and compare against
// the currently-stored value (which was computed from the LLM's
// self-reported hypothesis confidence).
//
// Read-only. Never writes; only reports.
// Run: npx tsx -r dotenv/config src/scripts/regressionOpportunityQualityP31.ts
import { prisma } from "../db/client";
import { computeOpportunityQuality, type ScoringInputs } from "../agents/scoring";
import { computeSupportingEvidenceStrength } from "../agents/evidenceStrength";
import { scoringConfigRepository } from "../repositories/scoringConfig.repository";

async function main() {
  const opportunities = await prisma.opportunity.findMany({
    include: { promotedFromCandidate: { include: { composition: true, run: true } } },
  });

  console.log(`Promoted opportunities inspected: ${opportunities.length}\n`);

  for (const opp of opportunities) {
    const cand = opp.promotedFromCandidate;
    const byRole = new Map(cand.composition.map((c) => [c.role, c.nodeId]));

    const [market, audience, problem, hypothesis, businessModel] = await Promise.all([
      byRole.get("market") ? prisma.market.findUnique({ where: { id: byRole.get("market")! } }) : null,
      byRole.get("audience") ? prisma.audience.findUnique({ where: { id: byRole.get("audience")! } }) : null,
      byRole.get("problem") ? prisma.problem.findUnique({ where: { id: byRole.get("problem")! } }) : null,
      byRole.get("hypothesis")
        ? prisma.hypothesis.findUnique({ where: { id: byRole.get("hypothesis")! } })
        : null,
      byRole.get("business_model")
        ? prisma.businessModel.findUnique({ where: { id: byRole.get("business_model")! } })
        : null,
    ]);
    if (!market || !audience || !problem || !hypothesis || !businessModel) {
      console.log(`✗ ${opp.id}: composition rows missing, skipping`);
      continue;
    }

    const config = await scoringConfigRepository.latestForVertical(cand.run.vertical);
    if (!config) {
      console.log(`✗ ${opp.id}: no scoring_config for vertical=${cand.run.vertical}`);
      continue;
    }

    // Recompute supportingEvidenceStrength from the hypothesis's
    // CURRENT supporting evidence — a re-derivation from ground truth
    // rather than trusting the stored (LLM-self-conf) value. For
    // freshly-created hypotheses post-P3.1 this is what would be
    // written at creation time (pre-Validation); for these existing
    // scored hypotheses it reflects post-Validation state.
    const refs = await prisma.nodeSourceRef.findMany({
      where: { nodeId: hypothesis.id, nodeType: "hypothesis", evidencePolarity: "supporting" },
    });
    const supportingEvidence = await prisma.evidence.findMany({
      where: { id: { in: refs.map((r) => r.evidenceId) } },
    });
    const groundedStrength = computeSupportingEvidenceStrength(
      supportingEvidence.map((e) => ({
        sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
        sourceAuthorityTier: e.sourceAuthorityTier,
      }))
    );

    const commonInputs = (strength: number | null): ScoringInputs => ({
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
        supportingEvidenceStrength: strength,
      },
      businessModel: {
        marginProfile: businessModel.marginProfile,
        operationalComplexityEstimate: businessModel.operationalComplexityEstimate,
        capitalIntensityEstimate: businessModel.capitalIntensityEstimate,
      },
    });
    const weights = {
      w1Demand: config.w1Demand,
      w2Hypothesis: config.w2Hypothesis,
      w3Margin: config.w3Margin,
      w4Feasibility: config.w4Feasibility,
      w5Distribution: config.w5Distribution,
      w6Timing: config.w6Timing,
    };

    // As-stored: use the DB-stored (LLM-self-conf) value. This reproduces
    // what the current opportunity_quality was computed from.
    const asStored = computeOpportunityQuality(commonInputs(hypothesis.supportingEvidenceStrength), weights);
    // Grounded: use the new deterministic evidence-strength value.
    const grounded = computeOpportunityQuality(commonInputs(groundedStrength), weights);

    console.log("─".repeat(80));
    console.log(`opportunity ${opp.id}`);
    console.log(`  candidate       : ${cand.id}`);
    console.log(`  hypothesis      : ${hypothesis.id}`);
    console.log(`  vertical        : ${cand.run.vertical}`);
    console.log(`  validationScore : ${hypothesis.validationScore}`);
    console.log(
      `  stored supporting_evidence_strength (LLM-self-conf) : ${hypothesis.supportingEvidenceStrength}`
    );
    console.log(`  grounded supporting_evidence_strength (new formula) : ${groundedStrength}`);
    console.log("");
    console.log(`  hypothesis sub-score:`);
    console.log(
      `    as-stored : ${asStored.subScores.hypothesis.toFixed(4)}   (avg(validation=${hypothesis.validationScore}, stored=${hypothesis.supportingEvidenceStrength}))`
    );
    console.log(
      `    grounded  : ${grounded.subScores.hypothesis.toFixed(4)}   (avg(validation=${hypothesis.validationScore}, grounded=${groundedStrength}))`
    );
    console.log("");
    console.log(`  opportunity_quality:`);
    console.log(
      `    DB-stored (from candidate.opportunityQuality) : ${cand.opportunityQuality}`
    );
    console.log(
      `    recomputed AS-STORED (sanity check)           : ${asStored.opportunityQuality.toFixed(4)}`
    );
    console.log(
      `    recomputed GROUNDED (new formula)             : ${grounded.opportunityQuality.toFixed(4)}`
    );
    const delta = grounded.opportunityQuality - asStored.opportunityQuality;
    console.log(
      `    Δ (grounded − as-stored)                      : ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`
    );

    // Sanity flag: does the recomputed-as-stored value match the
    // DB-stored one? If not, something else has drifted (scoring_config
    // version, composition change, etc) — flag it honestly rather than
    // silently ignoring.
    if (cand.opportunityQuality !== null) {
      const drift = Math.abs(asStored.opportunityQuality - cand.opportunityQuality);
      if (drift > 0.01) {
        console.log(
          `    ⚠ recomputed-as-stored disagrees with DB-stored by ${drift.toFixed(4)} — check scoring_config drift or composition changes`
        );
      }
    }
  }

  console.log("─".repeat(80));
  console.log(
    "\nNote: the AS-STORED path is what current DB values reflect. The GROUNDED path is what future Hypothesis Agent writes will produce (and what P3.1 argues opportunity_quality should have been all along)."
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
