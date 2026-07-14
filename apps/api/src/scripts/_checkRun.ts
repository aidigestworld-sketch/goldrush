import { prisma as p } from "../db/client";
async function main() {
  const runId = "91bc7de0-ddc8-43bd-98de-b45f43330e87";
  const probs = await p.problem.findMany({
    where: { pipelineRunId: runId },
    select: { id: true, label: true, status: true, confidence: true, deprecationReason: true },
  });
  console.log(`Problems total: ${probs.length}`);
  const active = probs.filter((x) => x.status === "active");
  const depr = probs.filter((x) => x.status === "deprecated");
  console.log(`  active: ${active.length}  deprecated: ${depr.length}`);
  for (const d of depr) console.log(`  DEPRECATED: "${d.label?.slice(0, 60)}"  reason=${d.deprecationReason}  conf=${d.confidence}`);
  for (const a of active) console.log(`  ACTIVE: conf=${a.confidence}  "${a.label?.slice(0, 60)}"`);

  const compMat = await p.evidence.findMany({ where: { sourceType: "competitor_material" }, select: { id: true, vertical: true, sourceUrlOrIdentifier: true, status: true } });
  console.log(`\ncompetitor_material evidence total: ${compMat.length}`);
  const b2bComp = compMat.filter(e => e.vertical === "b2b_customer_support_saas");
  console.log(`  b2b vertical: ${b2bComp.length}`);
  for (const e of b2bComp) console.log(`    ${e.status} ${e.sourceUrlOrIdentifier?.slice(0, 80)}`);

  const hyps = await p.hypothesis.findMany({ where: { pipelineRunId: runId } });
  console.log(`hypotheses: ${hyps.length}`);
  for (const h of hyps) console.log(`  hyp: "${(h.label ?? h.statement).slice(0, 80)}"  status=${h.status}`);

  // Check agent execution logs for CA and Hypothesis
  const logs = await p.agentExecutionLog.findMany({
    where: { runId },
    orderBy: { startedAt: "asc" },
  });
  console.log(`\nAgent execution logs (${logs.length}):`);
  for (const l of logs) {
    console.log(`  [${l.agentName}] status=${l.status}  graphMutations=${l.graphMutationCount ?? "n/a"}`);
  }

  // Check pipelineRun vertical
  const run = await p.pipelineRun.findUnique({ where: { runId } });
  console.log(`\npipelineRun.vertical: "${run?.vertical}"`);

  // Check what competitor map would look like
  const compRows = await p.evidence.findMany({
    where: { sourceType: "competitor_material", status: "active", vertical: run?.vertical ?? "" },
    select: { id: true, sourceUrlOrIdentifier: true },
  });
  console.log(`competitor_material rows for run vertical: ${compRows.length}`);

  // Simulate competitorNameFromUrl
  function nameFromUrl(url: string): string | null {
    if (url.includes("zendesk")) return "Zendesk";
    if (url.includes("intercom")) return "Intercom";
    if (url.includes("front.com") || url.includes("frontapp")) return "Front";
    if (url.includes("freshdesk") || url.includes("freshworks")) return "Freshdesk";
    if (url.includes("helpscout") || url.includes("help-scout")) return "Help Scout";
    if (url.includes("gorgias")) return "Gorgias";
    return null;
  }
  const mapEntries = new Map<string, number>();
  for (const r of compRows) {
    const name = nameFromUrl(r.sourceUrlOrIdentifier);
    if (name) mapEntries.set(name, (mapEntries.get(name) ?? 0) + 1);
    else console.log(`  no match: ${r.sourceUrlOrIdentifier.slice(0, 80)}`);
  }
  console.log(`competitor map: ${JSON.stringify(Object.fromEntries(mapEntries))}`);

  // Check what resolveProblemIdForRun returns
  const firstProblem = await p.problem.findFirst({
    where: { status: "active", pipelineRunId: runId },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\nresolveProblemIdForRun → id: ${firstProblem?.id ?? "null"}`);

  await p.$disconnect().catch(() => {});
}
main();
