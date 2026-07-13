// Freshness bench using source_published_at when available, falling
// back to fetched_at when not. Emits the exact table shape the task
// spec asked for:
//   evidence_id, source_type, age_days, freshness_score, which_date_used
//
// Read-only. No writes. No LLM calls.
// Run: npx tsx -r dotenv/config src/scripts/freshnessBenchSourceSide.ts
import { prisma } from "../db/client";
import { DECAY_CONSTANT_DAYS } from "../agents/confidenceMode2";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function freshness(ageDays: number, decay: number): number {
  return 1 / (1 + Math.max(0, ageDays) / decay);
}

async function main() {
  const now = new Date();
  console.log(`Source-side freshness bench @ ${now.toISOString()}`);
  console.log(`Formula: freshness = 1 / (1 + max(0, age_days) / ${DECAY_CONSTANT_DAYS})\n`);

  const rows = await prisma.evidence.findMany({
    where: { status: "active" },
    select: { id: true, sourceType: true, fetchedAt: true, sourcePublishedAt: true, sourceUrlOrIdentifier: true },
  });

  const scored = rows
    .map((r) => {
      const which: "source_published_at" | "fetched_at" = r.sourcePublishedAt ? "source_published_at" : "fetched_at";
      const date = r.sourcePublishedAt ?? r.fetchedAt;
      const ageDays = (now.getTime() - date.getTime()) / MS_PER_DAY;
      const score = freshness(ageDays, DECAY_CONSTANT_DAYS);
      return {
        evidence_id: r.id,
        source_type: r.sourceType,
        age_days: Number(ageDays.toFixed(3)),
        freshness_score: Number(score.toFixed(5)),
        which_date_used: which,
        url: r.sourceUrlOrIdentifier,
      };
    })
    .sort((a, b) => b.age_days - a.age_days); // oldest first — surface the tail

  console.log(`evidence_id,source_type,age_days,freshness_score,which_date_used`);
  for (const r of scored) {
    console.log(`${r.evidence_id},${r.source_type},${r.age_days},${r.freshness_score},${r.which_date_used}`);
  }

  // Summary — grouped by which_date_used so the ingestion-time-only
  // fallback rows don't distort the source-side signal.
  const bySrc = scored.filter((r) => r.which_date_used === "source_published_at");
  const byFetched = scored.filter((r) => r.which_date_used === "fetched_at");

  const summary = (label: string, xs: typeof scored) => {
    if (xs.length === 0) {
      console.log(`\n${label} (n=0) — no rows`);
      return;
    }
    const ages = xs.map((r) => r.age_days);
    const fresh = xs.map((r) => r.freshness_score);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    console.log(`\n${label} (n=${xs.length})`);
    console.log(`  age_days:        min=${Math.min(...ages).toFixed(3)}  max=${Math.max(...ages).toFixed(3)}  spread=${(Math.max(...ages) - Math.min(...ages)).toFixed(3)}`);
    console.log(`  freshness_score: min=${Math.min(...fresh).toFixed(4)}  max=${Math.max(...fresh).toFixed(4)}  mean=${mean(fresh).toFixed(4)}`);
  };

  summary("SOURCE-SIDE dates (real evidence age)", bySrc);
  summary("FETCHED-AT fallback (ingestion time; NOT a real age signal)", byFetched);

  console.log(
    "\nInterpretation:\n" +
      "  The SOURCE-SIDE rows are the only ones whose freshness score actually reflects\n" +
      "  the source's age. The FETCHED-AT rows all cluster at ~1-3 days age simply because\n" +
      "  they were seeded/scraped recently — that number is not measuring evidence age.\n" +
      "  Until source_published_at coverage grows past ~25%, blending freshness into\n" +
      "  confidence_score would still be dominated by fake age from the fallback rows."
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
