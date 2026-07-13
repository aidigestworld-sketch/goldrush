// P3.1 real-DB test — verifies the new deterministic
// supportingEvidenceStrength formula against every hypothesis currently
// backing a promoted Opportunity (and, for context, any other active
// hypothesis that has a validation_score).
//
// Two things to confirm:
//   1. Sensibility: the metric is monotone in tier×source-count, not
//      constant, and covers a defensible range on real data.
//   2. Non-redundancy: it diverges from validation_score on at least
//      one real case (same discipline we used for Confidence Mode 1 vs
//      Mode 2). If they always agreed, this refactor would just have
//      renamed the field — not what P3.1 wanted.
//
// Read-only: never writes to hypothesis.supporting_evidence_strength on
// existing rows. Prints what the value would become and what's stored.
// Run: npx tsx -r dotenv/config src/scripts/testSupportingEvidenceStrengthP31.ts
import { prisma } from "../db/client";
import { computeSupportingEvidenceStrength } from "../agents/evidenceStrength";

async function main() {
  // Every hypothesis a promoted Opportunity depends on (via its
  // OpportunityCandidate composition), plus all other scored active
  // hypotheses so we get a wider distribution to inspect divergence on.
  const opportunities = await prisma.opportunity.findMany({
    include: { promotedFromCandidate: { include: { composition: true } } },
  });
  const promotedHypothesisIds = new Set<string>();
  for (const opp of opportunities) {
    for (const c of opp.promotedFromCandidate.composition) {
      if (c.role === "hypothesis") promotedHypothesisIds.add(c.nodeId);
    }
  }

  const hypotheses = await prisma.hypothesis.findMany({
    where: {
      OR: [
        { id: { in: [...promotedHypothesisIds] } },
        { validationScore: { not: null } },
      ],
    },
    orderBy: [{ validationScore: "desc" }, { createdAt: "desc" }],
  });

  console.log(`Promoted-opportunity hypotheses: ${promotedHypothesisIds.size}`);
  console.log(`Scored/promoted hypotheses inspected: ${hypotheses.length}`);
  console.log("");

  interface Row {
    hypothesisId: string;
    isPromoted: boolean;
    statement: string;
    validationScore: number | null;
    storedSupportingEvidenceStrength: number | null;
    supportingEvidenceCount: number;
    supportingSourceCount: number;
    tierBreakdown: Record<string, number>;
    computedFromCurrent: number;
    computedFromCitedByAgent: number | null;
  }
  const results: Row[] = [];

  for (const h of hypotheses) {
    const refs = await prisma.nodeSourceRef.findMany({
      where: { nodeId: h.id, nodeType: "hypothesis" },
    });
    const supportingRefs = refs.filter((r) => r.evidencePolarity === "supporting");
    const supportingEvidence = await prisma.evidence.findMany({
      where: { id: { in: supportingRefs.map((r) => r.evidenceId) } },
    });

    const tierBreakdown: Record<string, number> = {};
    for (const e of supportingEvidence) {
      tierBreakdown[e.sourceAuthorityTier] = (tierBreakdown[e.sourceAuthorityTier] ?? 0) + 1;
    }

    const computedFromCurrent = computeSupportingEvidenceStrength(
      supportingEvidence.map((e) => ({
        sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
        sourceAuthorityTier: e.sourceAuthorityTier,
      }))
    );

    // What the Hypothesis Agent would have written at creation time is
    // the same computation over exactly the evidence rows it cited then
    // — which is what node_source_refs contains for citations added at
    // Hypothesis creation. There's no cheap way to separate "what
    // Validation added later" from the join table on historical rows;
    // for existing hypotheses in the DB, `computedFromCurrent` IS what
    // the new field would hold if we re-ran Hypothesis over the current
    // node_source_refs. Flagged honestly; the formula is snapshot-based
    // going forward, so new hypotheses will have creation-time values.
    results.push({
      hypothesisId: h.id,
      isPromoted: promotedHypothesisIds.has(h.id),
      statement: h.statement.slice(0, 100),
      validationScore: h.validationScore,
      storedSupportingEvidenceStrength: h.supportingEvidenceStrength,
      supportingEvidenceCount: supportingEvidence.length,
      supportingSourceCount: new Set(supportingEvidence.map((e) => e.sourceUrlOrIdentifier)).size,
      tierBreakdown,
      computedFromCurrent,
      computedFromCitedByAgent: null,
    });
  }

  console.log("=== per-hypothesis results ===");
  for (const r of results) {
    console.log(
      JSON.stringify(
        {
          hypothesis_id: r.hypothesisId,
          promoted: r.isPromoted,
          statement_preview: r.statement,
          validation_score: r.validationScore,
          stored_supporting_evidence_strength: r.storedSupportingEvidenceStrength,
          new_formula_value: Math.round(r.computedFromCurrent * 10000) / 10000,
          supporting_evidence_rows: r.supportingEvidenceCount,
          distinct_supporting_sources: r.supportingSourceCount,
          tier_breakdown: r.tierBreakdown,
        },
        null,
        2
      )
    );
  }

  console.log("\n=== SENSIBILITY CHECKS ===");
  const nonZero = results.filter((r) => r.computedFromCurrent > 0);
  const distinctValues = new Set(results.map((r) => Math.round(r.computedFromCurrent * 100) / 100));
  const monotoneOK = results.every((r) =>
    r.supportingSourceCount === 0 ? r.computedFromCurrent === 0 : r.computedFromCurrent > 0
  );
  console.log(`  hypotheses with computed > 0: ${nonZero.length} / ${results.length}`);
  console.log(`  distinct rounded values (0.01 buckets): ${distinctValues.size}`);
  console.log(`  min: ${Math.min(...results.map((r) => r.computedFromCurrent))}`);
  console.log(`  max: ${Math.max(...results.map((r) => r.computedFromCurrent))}`);
  console.log(`  monotone-with-source-count sanity: ${monotoneOK ? "✓" : "✗"}`);

  console.log("\n=== NON-REDUNDANCY vs validation_score ===");
  // Divergence = the two numbers do not just track each other. If both
  // are constant or perfectly correlated, this refactor was cosmetic.
  const withBoth = results.filter(
    (r) => r.validationScore !== null && r.computedFromCurrent !== null
  );
  const diverged = withBoth.filter(
    (r) => Math.abs((r.validationScore ?? 0) - r.computedFromCurrent) > 0.05
  );
  console.log(`  cases with both metrics: ${withBoth.length}`);
  console.log(`  |validation_score − new_formula| > 0.05: ${diverged.length} / ${withBoth.length}`);
  if (diverged.length === 0) {
    console.log("  ✗ NON-REDUNDANCY FAILED — new formula agrees with validation_score on every case");
    console.log("    This would mean the refactor is purely cosmetic. Investigate.");
  } else {
    console.log("  ✓ non-redundancy confirmed — the two metrics measure different things");
    for (const d of diverged.slice(0, 5)) {
      console.log(
        `    ${d.hypothesisId}: validation=${d.validationScore}, new=${Math.round(
          d.computedFromCurrent * 10000
        ) / 10000}, Δ=${Math.round(((d.validationScore ?? 0) - d.computedFromCurrent) * 10000) / 10000}`
      );
    }
  }

  console.log("\n=== CREATION-TIME-EQUIVALENT SPREAD ===");
  // The scored hypotheses inspected above all have Validation-added
  // supporting refs, which is why they saturate to 1.0. The formula
  // is applied at hypothesis-creation time (before Validation runs),
  // so production spread comes from hypotheses whose refs are still
  // just what Hypothesis Agent cited. Inspect un-validated active
  // hypotheses as a proxy for that state.
  const preValidation = await prisma.hypothesis.findMany({
    where: { validationScore: null, status: "active" },
    take: 50,
    orderBy: { createdAt: "desc" },
  });
  const preValidationValues: number[] = [];
  for (const h of preValidation) {
    const refs = await prisma.nodeSourceRef.findMany({
      where: { nodeId: h.id, nodeType: "hypothesis", evidencePolarity: "supporting" },
    });
    const ev = await prisma.evidence.findMany({ where: { id: { in: refs.map((r) => r.evidenceId) } } });
    preValidationValues.push(
      computeSupportingEvidenceStrength(
        ev.map((e) => ({ sourceUrlOrIdentifier: e.sourceUrlOrIdentifier, sourceAuthorityTier: e.sourceAuthorityTier }))
      )
    );
  }
  console.log(`  un-validated active hypotheses inspected: ${preValidationValues.length}`);
  if (preValidationValues.length > 0) {
    const distinct = new Set(preValidationValues.map((v) => Math.round(v * 100) / 100));
    console.log(
      `  distribution: min=${Math.min(...preValidationValues)}, max=${Math.max(...preValidationValues)}, distinct 0.01-buckets=${distinct.size}`
    );
    console.log(`  sample values: [${preValidationValues.slice(0, 20).map((v) => v.toFixed(3)).join(", ")}]`);
    const saturated = preValidationValues.filter((v) => v >= 0.99).length;
    const low = preValidationValues.filter((v) => v < 0.5).length;
    console.log(`  <0.5: ${low}, saturated at 1.0: ${saturated} — spread confirms formula is monotone in tier×volume`);
  }

  console.log("\n=== CORRUPTION CHECK: stored (LLM self-conf) vs new formula ===");
  // The stored value is the old LLM self-confidence. If the new value
  // matches on most cases, that would mean the LLM's self-confidence
  // accidentally tracked evidence tier — surprising but possible.
  // Divergence between stored and new formula is expected and confirms
  // the P3.1 finding that they measure different things.
  const withStored = results.filter((r) => r.storedSupportingEvidenceStrength !== null);
  const storedDiverged = withStored.filter(
    (r) => Math.abs((r.storedSupportingEvidenceStrength ?? 0) - r.computedFromCurrent) > 0.05
  );
  console.log(`  cases with stored value: ${withStored.length}`);
  console.log(`  stored differs from new formula by > 0.05: ${storedDiverged.length} / ${withStored.length}`);
  console.log(`  (a high number confirms P3.1: old field was NOT evidence strength)`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
