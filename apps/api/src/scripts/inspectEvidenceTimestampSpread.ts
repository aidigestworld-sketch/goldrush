// Quick read-only survey of fetched_at spread across the current
// evidence table. Feeds the freshness bench's design: we need to
// know whether the corpus has enough age spread to be useful for
// evaluating DECAY_CONSTANT_DAYS.
// Run: npx tsx -r dotenv/config src/scripts/inspectEvidenceTimestampSpread.ts
import { prisma } from "../db/client";

async function main() {
  const rows = await prisma.evidence.findMany({
    where: { status: "active" },
    select: { id: true, sourceType: true, fetchedAt: true, sourceUrlOrIdentifier: true },
    orderBy: { fetchedAt: "asc" },
  });

  const now = new Date();
  const ageDaysOf = (d: Date) => (now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000);

  const byType = new Map<string, { count: number; oldest: Date; newest: Date }>();
  for (const r of rows) {
    const entry = byType.get(r.sourceType);
    if (!entry) {
      byType.set(r.sourceType, { count: 1, oldest: r.fetchedAt, newest: r.fetchedAt });
    } else {
      entry.count++;
      if (r.fetchedAt < entry.oldest) entry.oldest = r.fetchedAt;
      if (r.fetchedAt > entry.newest) entry.newest = r.fetchedAt;
    }
  }

  console.log(`Total active evidence: ${rows.length}`);
  console.log(`Now (script clock): ${now.toISOString()}`);
  if (rows.length > 0) {
    console.log(`Global oldest fetched_at: ${rows[0].fetchedAt.toISOString()} (age ${ageDaysOf(rows[0].fetchedAt).toFixed(2)}d)`);
    console.log(`Global newest fetched_at: ${rows[rows.length - 1].fetchedAt.toISOString()} (age ${ageDaysOf(rows[rows.length - 1].fetchedAt).toFixed(2)}d)`);
    console.log(`Global spread: ${(ageDaysOf(rows[0].fetchedAt) - ageDaysOf(rows[rows.length - 1].fetchedAt)).toFixed(2)}d`);
  }

  console.log("\n=== By source_type ===");
  for (const [t, meta] of byType) {
    console.log(
      `${t}: n=${meta.count}, oldest_age=${ageDaysOf(meta.oldest).toFixed(2)}d, newest_age=${ageDaysOf(meta.newest).toFixed(2)}d, spread=${(ageDaysOf(meta.oldest) - ageDaysOf(meta.newest)).toFixed(2)}d`
    );
  }

  console.log("\n=== 10 oldest evidence rows ===");
  for (const r of rows.slice(0, 10)) {
    console.log(
      `  ${r.fetchedAt.toISOString()} (age ${ageDaysOf(r.fetchedAt).toFixed(2)}d) [${r.sourceType}] id=${r.id.substring(0, 8)} src=${r.sourceUrlOrIdentifier.substring(0, 60)}`
    );
  }
  console.log("\n=== 10 newest evidence rows ===");
  for (const r of rows.slice(-10)) {
    console.log(
      `  ${r.fetchedAt.toISOString()} (age ${ageDaysOf(r.fetchedAt).toFixed(2)}d) [${r.sourceType}] id=${r.id.substring(0, 8)} src=${r.sourceUrlOrIdentifier.substring(0, 60)}`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
