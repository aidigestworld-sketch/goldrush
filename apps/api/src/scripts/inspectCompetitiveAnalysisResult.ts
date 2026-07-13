import { prisma } from "../db/client";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";
const PROBLEM_ID = "173a0c23-e41d-4c32-af0c-d484c9add01a";

async function main() {
  const existingSolutions = await prisma.existingSolution.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  console.log("=== existing_solution rows (latest 20, newest first) ===");
  console.log(JSON.stringify(existingSolutions, null, 2));

  const businessModels = await prisma.businessModel.findMany({
    orderBy: { id: "asc" },
  });
  console.log("\n=== business_model rows (all) ===");
  console.log(JSON.stringify(businessModels, null, 2));

  const logs = await prisma.agentExecutionLog.findMany({
    where: { runId: RUN_ID, agentName: "CompetitiveAnalysis" },
    orderBy: { startedAt: "desc" },
    take: 3,
  });
  console.log("\n=== recent CompetitiveAnalysis agent_execution_log entries ===");
  console.log(JSON.stringify(logs, null, 2));

  console.log("\n=== target problem ===");
  console.log(JSON.stringify(await prisma.problem.findUnique({ where: { id: PROBLEM_ID } }), null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
