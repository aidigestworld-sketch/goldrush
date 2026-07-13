// Diagnostic: show hypothesis_sources rows per given hypothesisId(s).
// Run: npx tsx -r dotenv/config src/scripts/inspectHypothesisSources.ts <id1> [id2] ...
import { prisma } from "../db/client";

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) throw new Error("usage: inspectHypothesisSources.ts <hypothesisId> [more...]");
  const sources = await prisma.hypothesisSource.findMany({ where: { hypothesisId: { in: ids } } });
  for (const id of ids) {
    const rows = sources.filter((s) => s.hypothesisId === id);
    console.log(`\n=== hypothesis ${id} ===`);
    console.log(`  hypothesis_sources rows: ${rows.length}`);
    for (const r of rows) {
      console.log(
        JSON.stringify({ problemId: r.problemId, existingSolutionId: r.existingSolutionId }, null, 2)
      );
    }
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
