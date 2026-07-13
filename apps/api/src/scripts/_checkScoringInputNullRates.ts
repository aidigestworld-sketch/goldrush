// P1.1/P2.1 investigation — measure the null-rate of every field the
// deterministic Scoring formula silently pads with NEUTRAL_DEFAULT=0.5
// across the real DB corpus. Scope, per the task spec:
//   1. all real candidates (promoted + non-promoted)
//   2. only nodes that were actually composed onto a candidate (i.e.
//      that Scoring would have consumed)
// Also breaks out the promoted-only slice so we can see whether
// "the ones that reached Opportunity" differ from the general pool.
//
// Read-only. Prints exact counts, not just percentages — sample sizes
// are small.
//
// Run: npx tsx -r dotenv/config src/scripts/_checkScoringInputNullRates.ts
import { prisma } from "../db/client";

async function main() {
  const candidates = await prisma.opportunityCandidate.findMany({
    select: { id: true, status: true, runId: true },
  });
  const compRows = await prisma.opportunityCandidateComposition.findMany();
  const byCandidate = new Map<string, { role: string; nodeId: string }[]>();
  for (const c of compRows) {
    if (!byCandidate.has(c.candidateId)) byCandidate.set(c.candidateId, []);
    byCandidate.get(c.candidateId)!.push({ role: c.role, nodeId: c.nodeId });
  }

  // Build per-role sets of node IDs, split by candidate status:
  // "promoted" (reached Opportunity) vs "other" (candidate/deprecated).
  const roleIds = {
    market: { promoted: new Set<string>(), other: new Set<string>() },
    audience: { promoted: new Set<string>(), other: new Set<string>() },
    hypothesis: { promoted: new Set<string>(), other: new Set<string>() },
    business_model: { promoted: new Set<string>(), other: new Set<string>() },
  };
  for (const cand of candidates) {
    const bucket = cand.status === "promoted" ? "promoted" : "other";
    const parts = byCandidate.get(cand.id) ?? [];
    for (const p of parts) {
      if (p.role in roleIds) {
        (roleIds as any)[p.role][bucket].add(p.nodeId);
      }
    }
  }

  console.log(`=== corpus scope ===`);
  console.log(`  candidates total=${candidates.length}  promoted=${candidates.filter((c) => c.status === "promoted").length}  other=${candidates.filter((c) => c.status !== "promoted").length}`);
  for (const role of ["market", "audience", "hypothesis", "business_model"] as const) {
    const p = (roleIds as any)[role].promoted.size;
    const o = (roleIds as any)[role].other.size;
    console.log(`  role=${role.padEnd(15)} distinct nodes composed onto promoted=${p}, onto other=${o}`);
  }

  // Helper to fetch + tabulate a single Float? field on a table.
  async function tabulate(
    label: string,
    fetchAll: () => Promise<Array<Record<string, unknown>>>,
    ids: { promoted: Set<string>; other: Set<string> },
    field: string
  ) {
    const rows = await fetchAll();
    const isNull = (r: any) => r[field] === null || r[field] === undefined;
    const total = rows.length;
    const totalNull = rows.filter(isNull).length;
    const composedPromoted = rows.filter((r: any) => ids.promoted.has(r.id));
    const composedOther = rows.filter((r: any) => ids.other.has(r.id));
    const promotedNull = composedPromoted.filter(isNull).length;
    const otherNull = composedOther.filter(isNull).length;
    console.log(
      `\n  ${label}`.padEnd(38) +
        `\n    all-active rows: ${totalNull}/${total} null (${total === 0 ? "0.0" : ((totalNull / total) * 100).toFixed(1)}%)` +
        `\n    composed onto PROMOTED candidate: ${promotedNull}/${composedPromoted.length} null` +
        `\n    composed onto other candidate:    ${otherNull}/${composedOther.length} null`
    );
    // For the smaller composed-slice cases print exact values so we
    // can see what real distribution the promoted decisions saw.
    if (composedPromoted.length <= 12) {
      const vals = composedPromoted
        .map((r: any) => (isNull(r) ? "NULL" : Number(r[field]).toFixed(3)))
        .join(", ");
      console.log(`    promoted values: [${vals}]`);
    }
    if (composedOther.length <= 12) {
      const vals = composedOther
        .map((r: any) => (isNull(r) ? "NULL" : Number(r[field]).toFixed(3)))
        .join(", ");
      console.log(`    other values:    [${vals}]`);
    }
  }

  console.log(`\n=== per-field null rates ===`);
  await tabulate(
    "market.growthRateEstimate",
    () => prisma.market.findMany({ where: { status: "active" }, select: { id: true, growthRateEstimate: true } }),
    roleIds.market,
    "growthRateEstimate"
  );
  await tabulate(
    "audience.willingnessToPaySignal",
    () => prisma.audience.findMany({ where: { status: "active" }, select: { id: true, willingnessToPaySignal: true } }),
    roleIds.audience,
    "willingnessToPaySignal"
  );
  await tabulate(
    "hypothesis.validationScore",
    () => prisma.hypothesis.findMany({ where: { status: "active" }, select: { id: true, validationScore: true } }),
    roleIds.hypothesis,
    "validationScore"
  );
  await tabulate(
    "hypothesis.supportingEvidenceStrength",
    () => prisma.hypothesis.findMany({ where: { status: "active" }, select: { id: true, supportingEvidenceStrength: true } }),
    roleIds.hypothesis,
    "supportingEvidenceStrength"
  );
  await tabulate(
    "businessModel.marginProfile",
    () => prisma.businessModel.findMany({ where: { status: "active" }, select: { id: true, marginProfile: true } }),
    roleIds.business_model,
    "marginProfile"
  );
  await tabulate(
    "businessModel.operationalComplexityEstimate",
    () =>
      prisma.businessModel.findMany({
        where: { status: "active" },
        select: { id: true, operationalComplexityEstimate: true },
      }),
    roleIds.business_model,
    "operationalComplexityEstimate"
  );
  await tabulate(
    "businessModel.capitalIntensityEstimate",
    () =>
      prisma.businessModel.findMany({
        where: { status: "active" },
        select: { id: true, capitalIntensityEstimate: true },
      }),
    roleIds.business_model,
    "capitalIntensityEstimate"
  );

  // Also count deprecated hypotheses so we know how many exist that
  // could have blocked Composition on validation-score grounds.
  console.log(`\n=== supporting diagnostics ===`);
  const allHyp = await prisma.hypothesis.count();
  const activeHyp = await prisma.hypothesis.count({ where: { status: "active" } });
  const depHyp = await prisma.hypothesis.count({ where: { status: "deprecated" } });
  const nullValActive = await prisma.hypothesis.count({ where: { status: "active", validationScore: null } });
  const nullValDep = await prisma.hypothesis.count({ where: { status: "deprecated", validationScore: null } });
  console.log(`  hypothesis: total=${allHyp}  active=${activeHyp}  deprecated=${depHyp}`);
  console.log(`    null validationScore among active: ${nullValActive}`);
  console.log(`    null validationScore among deprecated: ${nullValDep}`);

  // node_source_refs summary — how many active hypotheses have at
  // least one 'supporting' evidence citation. Bears on P3.1's
  // supportingEvidenceStrength: post-P3.1 it's deterministic from
  // evidence, so a hypothesis with zero supporting refs would give a
  // legitimately-defined value of 0.0 (band floor), not null.
  const activeHyps = await prisma.hypothesis.findMany({ where: { status: "active" }, select: { id: true } });
  let hypWithSupporting = 0;
  let hypWithAnyEvidence = 0;
  for (const h of activeHyps) {
    const refs = await prisma.nodeSourceRef.findMany({
      where: { nodeId: h.id, nodeType: "hypothesis" },
      select: { evidencePolarity: true },
    });
    if (refs.length > 0) hypWithAnyEvidence++;
    if (refs.some((r) => r.evidencePolarity === "supporting")) hypWithSupporting++;
  }
  console.log(`  active hypotheses w/ ≥1 cited evidence: ${hypWithAnyEvidence}/${activeHyps.length}`);
  console.log(`  active hypotheses w/ ≥1 SUPPORTING evidence: ${hypWithSupporting}/${activeHyps.length}`);

  await prisma.$disconnect().catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
