// One-shot setup state inspector for b2b_customer_support_saas onboarding.
// Run: npx tsx --env-file=.env src/scripts/checkB2BSetupState.ts
import { prisma } from "../db/client";

const VERTICAL = "b2b_customer_support_saas";

async function main() {
  const sc = await prisma.scoringConfig.findFirst({ where: { vertical: VERTICAL } });
  console.log("=== scoring_config ===");
  console.log(JSON.stringify(sc, null, 2));

  const founder = await prisma.founder.findFirst();
  console.log("\n=== founder ===");
  console.log(`id=${founder?.id}  industries=${founder?.industries.join(",")}`);

  const evBySrc = await prisma.evidence.groupBy({
    by: ["sourceType"],
    where: { status: "active", sourceUrlOrIdentifier: { contains: `probe=${VERTICAL}` } },
    _count: true,
  });
  console.log("\n=== evidence by sourceType (probe rows) ===");
  for (const row of evBySrc) console.log(`  ${row.sourceType}: ${row._count}`);

  const compRows = await prisma.evidence.findMany({
    where: { sourceType: "competitor_material", status: "active", sourceUrlOrIdentifier: { contains: `probe=${VERTICAL}` } },
    select: { id: true, sourceUrlOrIdentifier: true },
  });
  console.log("\n=== competitor_material URLs ===");
  for (const r of compRows) console.log(`  [${r.id.slice(0,8)}] ${r.sourceUrlOrIdentifier}`);

  const modelRoutes = await prisma.modelRoutingConfig.findMany({ orderBy: { effectiveFrom: "asc" } });
  console.log("\n=== model_routing_config rows ===");
  for (const r of modelRoutes) console.log(`  agentName=${r.agentName}  model=${r.nimModelId}  tier=${r.tier}`);

  const existingRuns = await prisma.pipelineRun.findMany({
    where: { vertical: VERTICAL },
    orderBy: { startedAt: "desc" },
  });
  console.log("\n=== pipeline_runs for this vertical ===");
  for (const r of existingRuns) console.log(`  runId=${r.runId}  startedAt=${r.startedAt}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
