// P3.2 diagnostic — recheck what fraction of Evidence rows currently
// have sourcePublishedAt populated. Prior measurement (per freshness
// investigation): ~25% for search_signal, 0% elsewhere. The fallback
// strategy in the recency fix depends on this ratio not having
// meaningfully shifted upward.
//
// Read-only. Also breaks out the two candidates on the known 4-way
// tie run 28e862eb so the follow-up recency-tiebreak recomputation
// task has the exact data it needs.
//
// Run: npx tsx -r dotenv/config src/scripts/_checkSourcePublishedAtPopulation.ts
import { prisma } from "../db/client";

async function main() {
  console.log("=== overall population by sourceType ===");
  const bySourceType = await prisma.evidence.groupBy({
    by: ["sourceType"],
    _count: { _all: true },
  });
  for (const row of bySourceType) {
    const withPublished = await prisma.evidence.count({
      where: { sourceType: row.sourceType, sourcePublishedAt: { not: null } },
    });
    const pct = row._count._all === 0 ? 0 : (withPublished / row._count._all) * 100;
    console.log(
      `  ${row.sourceType.padEnd(28)}  total=${String(row._count._all).padStart(4)}  withPublished=${String(withPublished).padStart(4)}  ${pct.toFixed(1)}%`
    );
  }

  const grandTotal = await prisma.evidence.count();
  const grandWithPublished = await prisma.evidence.count({ where: { sourcePublishedAt: { not: null } } });
  console.log(
    `\n  ${"OVERALL".padEnd(28)}  total=${String(grandTotal).padStart(4)}  withPublished=${String(grandWithPublished).padStart(4)}  ${((grandWithPublished / Math.max(1, grandTotal)) * 100).toFixed(1)}%`
  );

  console.log("\n=== per-candidate lastEvidenceSeenAt for run 28e862eb (the known 4-way tie) ===");
  const runId = "28e862eb";
  // pipeline_run.runId is UUID — Prisma won't accept startsWith on that.
  // Fetch all and prefix-filter in JS. Cheap given the run count.
  const allRuns = await prisma.pipelineRun.findMany({ select: { runId: true, vertical: true, currentStage: true, status: true } });
  const runs = allRuns.filter((r) => r.runId.startsWith(runId));
  if (runs.length === 0) {
    console.log(`  (no pipeline_run with runId starting ${runId})`);
    return;
  }
  for (const r of runs) {
    console.log(`\n  run ${r.runId} (${r.vertical})`);
    const candidates = await prisma.opportunityCandidate.findMany({
      where: { runId: r.runId },
      select: { id: true, status: true, opportunityQuality: true, founderFitScore: true, confidenceScore: true, createdAt: true },
    });
    for (const c of candidates) {
      const comp = await prisma.opportunityCandidateComposition.findMany({
        where: { candidateId: c.id },
        select: { nodeId: true },
      });
      const nodeIds = comp.map((x) => x.nodeId);
      const refs = nodeIds.length
        ? await prisma.nodeSourceRef.findMany({ where: { nodeId: { in: nodeIds } }, select: { evidenceId: true } })
        : [];
      const evidenceIds = [...new Set(refs.map((r) => r.evidenceId))];
      const evRows = evidenceIds.length
        ? await prisma.evidence.findMany({
            where: { id: { in: evidenceIds } },
            select: { id: true, fetchedAt: true, sourcePublishedAt: true, sourceType: true },
          })
        : [];
      let maxFetched = new Date(0);
      let maxPublishedOrFetched = new Date(0);
      let publishedCount = 0;
      let usedPublishedForMax = false;
      for (const e of evRows) {
        if (e.fetchedAt > maxFetched) maxFetched = e.fetchedAt;
        const recency = e.sourcePublishedAt ?? e.fetchedAt;
        if (e.sourcePublishedAt) publishedCount++;
        if (recency > maxPublishedOrFetched) {
          maxPublishedOrFetched = recency;
          usedPublishedForMax = e.sourcePublishedAt !== null;
        }
      }
      console.log(
        `    cand ${c.id.slice(0, 8)} status=${c.status}  evCount=${evRows.length}  withPublished=${publishedCount}` +
          `  maxFetched=${maxFetched.getTime() === 0 ? "n/a" : maxFetched.toISOString()}` +
          `  maxRecency=${maxPublishedOrFetched.getTime() === 0 ? "n/a" : maxPublishedOrFetched.toISOString()}` +
          `  maxRecencyUsedPublished=${usedPublishedForMax}`
      );
    }
  }

  await prisma.$disconnect().catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
