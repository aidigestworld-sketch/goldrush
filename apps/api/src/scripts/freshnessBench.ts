// Confidence Mode 2 freshness curve bench.
//
// PURPOSE: the DECAY_CONSTANT_DAYS constant in confidenceMode2.ts is
// provisional (90 days). This script exists so a reviewer can see
// what the curve `freshness = 1 / (1 + age_days / DECAY)` actually
// produces before we lock the constant in.
//
// TWO PARTS, DELIBERATELY:
//
// Part A — REAL evidence: iterates every active row in the evidence
// table, computes freshness_per_evidence with the current constant,
// emits a table sorted by age. This is the honest ground truth for
// what the constant does to the corpus AS IT STANDS TODAY.
//
// Part B — SYNTHETIC age curve: applies the same pure formula to
// a fixed list of hypothetical ages [0d, 1d, 7d, 30d, 60d, 90d, 180d,
// 365d, 730d] so the reviewer can see the KNEE and TAIL of the curve
// without needing evidence rows to match. This is a plot-the-math
// exercise, NOT synthetic evidence — no rows are inserted, no dates
// are fabricated on any real evidence row. It's just "here's what
// the formula does at age X" for common Xs.
//
// KNOWN GAP (surfaced explicitly per the task's instruction):
//   The current corpus has a global fetched_at spread of ~1.54 days —
//   all evidence is either from the manual seed run (Jul 5) or the
//   Validation search runs (Jul 6-7). There are NO evidence rows old
//   enough to exercise the tail of the curve (past ~90 days), so
//   Part A cannot on its own show whether DECAY=90 is "too shallow"
//   or "too aggressive" for actual older sources. That question is
//   what Part B is for.
//   To close this gap on real data, the corpus would need evidence
//   rows fetched >> 90 days ago (e.g., older industry_report or
//   financial_signal ingests). This is data availability, not a code
//   or formula gap — noted here so it isn't mistaken for a
//   confidenceMode2.ts bug later.
//
// Read-only. No writes. No LLM calls.
// Run: npx tsx -r dotenv/config src/scripts/freshnessBench.ts
import { prisma } from "../db/client";
import { DECAY_CONSTANT_DAYS } from "../agents/confidenceMode2";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function freshness(ageDays: number, decay: number): number {
  return 1 / (1 + Math.max(0, ageDays) / decay);
}

async function main() {
  const now = new Date();
  console.log(`Freshness bench @ ${now.toISOString()}`);
  console.log(`Formula: freshness = 1 / (1 + max(0, age_days) / DECAY)`);
  console.log(`Current DECAY_CONSTANT_DAYS = ${DECAY_CONSTANT_DAYS}\n`);

  // ---- Part A: real evidence rows through the current curve ----
  const rows = await prisma.evidence.findMany({
    where: { status: "active" },
    select: { id: true, sourceType: true, fetchedAt: true, sourceUrlOrIdentifier: true },
    orderBy: { fetchedAt: "asc" }, // oldest first
  });

  console.log(`--- Part A: freshness_per_evidence on real corpus (n=${rows.length}) ---`);
  console.log("evidence_id,age_days,freshness_score,source_type,source_ref");
  const partA: {
    evidence_id: string;
    age_days: number;
    freshness_score: number;
    source_type: string;
    source_ref: string;
  }[] = [];
  for (const r of rows) {
    const ageDays = (now.getTime() - r.fetchedAt.getTime()) / MS_PER_DAY;
    const score = freshness(ageDays, DECAY_CONSTANT_DAYS);
    partA.push({
      evidence_id: r.id,
      age_days: Number(ageDays.toFixed(4)),
      freshness_score: Number(score.toFixed(6)),
      source_type: r.sourceType,
      source_ref: r.sourceUrlOrIdentifier,
    });
    console.log(`${r.id},${ageDays.toFixed(4)},${score.toFixed(6)},${r.sourceType},${r.sourceUrlOrIdentifier}`);
  }

  if (rows.length > 0) {
    const ages = partA.map((p) => p.age_days);
    const scores = partA.map((p) => p.freshness_score);
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    console.log(
      `\nPart A summary: age_days min=${Math.min(...ages).toFixed(2)} max=${Math.max(...ages).toFixed(2)} spread=${(Math.max(...ages) - Math.min(...ages)).toFixed(2)}`
    );
    console.log(
      `Part A summary: freshness min=${Math.min(...scores).toFixed(4)} max=${Math.max(...scores).toFixed(4)} mean=${mean(scores).toFixed(4)}`
    );
    console.log(
      "OBSERVATION: with corpus this fresh, EVERY evidence lands in the top of the curve — the current constant does not discriminate between rows. Part B is where the curve shape is actually visible."
    );
  }

  // ---- Part B: synthetic age curve — plot the math, not fake evidence ----
  const decays = [30, 60, 90, 180, 365];
  const hypotheticalAgesDays = [0, 1, 7, 14, 30, 60, 90, 120, 180, 270, 365, 540, 730, 1095];

  console.log(`\n--- Part B: freshness curve over hypothetical ages, across candidate DECAY values ---`);
  console.log("age_days," + decays.map((d) => `decay_${d}d`).join(","));
  for (const age of hypotheticalAgesDays) {
    const cells = decays.map((d) => freshness(age, d).toFixed(4));
    console.log(`${age},${cells.join(",")}`);
  }

  console.log(
    "\nReading the table: pick a DECAY column; the value at age=DECAY is 0.5 (the half-life point). Values above the row for age=DECAY are the pre-knee region; below are the tail."
  );
  console.log(
    "Suggested read: for a curve where 'a source from 6 months ago is worth ~half of a fresh one,' DECAY=180 is the right knee. For 'a source from 3 months ago is worth ~half,' DECAY=90 is right. Confirm the intended half-life before locking in."
  );

  console.log(
    "\n--- KNOWN GAP note ---\n" +
      "The bench cannot validate DECAY on real corpus rows because no evidence in the DB\n" +
      "is old enough to reach the curve's knee (all rows are <2 days old). Part B stands\n" +
      "in for that check by showing the pure math of the curve; Part A is a sanity check\n" +
      "that the formula runs cleanly on real rows, not a test of the DECAY value itself.\n" +
      "TODO: revisit Part A once the corpus contains evidence >90 days old (natural\n" +
      "outcome of running the pipeline in production, or a targeted ingest of older\n" +
      "industry_report/financial_signal material)."
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
