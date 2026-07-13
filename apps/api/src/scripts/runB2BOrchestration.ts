// Full 12-stage DAG run for b2b_customer_support_saas via the Orchestrator HTTP API.
// Starts the server+workers in-process, fires the orchestrate endpoint, polls until
// completion, then prints a structured report of every promoted artifact.
//
// Run: npx tsx --env-file=.env src/scripts/runB2BOrchestration.ts
//
// The tracking key (B2B_TRACKING_KEY) is a stable UUID scoped to this vertical.
// Re-running the script resumes from wherever the last run left off (idempotent).
// To force a fresh run, delete dag_run_state rows for this tracking key first.

import { startServer } from "../api/server";
import { prisma } from "../db/client";

const VERTICAL = "b2b_customer_support_saas";
// Stable tracking key — stored as hypothesis_id in dag_run_state.
// Changing this forces a new run; keeping it stable lets re-runs resume.
const B2B_TRACKING_KEY = "b2b00000-0000-0000-0000-000000000001";
const POLL_INTERVAL_MS = 8_000;
const TIMEOUT_MS = 30 * 60 * 1_000; // 30 min hard stop

async function poll(base: string, trackingKey: string): Promise<void> {
  const statusUrl = `${base}/hypotheses/${trackingKey}/status`;
  const deadline = Date.now() + TIMEOUT_MS;
  let dots = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(statusUrl);
    if (!res.ok) {
      console.warn(`  [poll] status ${res.status}: ${await res.text()}`);
      continue;
    }
    const body = (await res.json()) as {
      overall: string;
      steps: { step: string; status: string; lastError?: string | null }[];
    };

    // Print running step(s)
    const running = body.steps.filter((s) => s.status === "running").map((s) => s.step);
    const failed = body.steps.filter((s) => s.status === "failed_permanent");
    process.stdout.write(`\r  [${++dots}] overall=${body.overall}  running=[${running.join(",")}]   `);

    if (failed.length > 0) {
      console.log();
      for (const f of failed) console.error(`  FAILED step=${f.step}  error=${f.lastError ?? ""}`);
      console.log("\n  Run halted — partial results shown below.");
      return;
    }
    if (body.overall === "completed") {
      console.log("\n  All steps succeeded.");
      return;
    }
  }

  console.log("\n  TIMEOUT: run did not complete within 30 minutes.");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function report(runId: string) {
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  B2B ORCHESTRATION RESULT  runId=${runId}`);
  console.log("════════════════════════════════════════════════════════\n");

  // Discovery
  const markets = await prisma.market.findMany({
    where: { pipelineRunId: runId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  console.log(`── Discovery: ${markets.length} market(s) ──`);
  for (const m of markets) console.log(`  [market] "${m.label}"  growthRate=${m.growthRateEstimate ?? "n/a"}  maturity=${m.maturityStage}`);

  // Expansion
  const audiences = await prisma.audience.findMany({ where: { pipelineRunId: runId, status: "active" } });
  const problems = await prisma.problem.findMany({ where: { pipelineRunId: runId, status: "active" } });
  console.log(`\n── Expansion: ${audiences.length} audience(s), ${problems.length} problem(s) ──`);
  for (const a of audiences) console.log(`  [audience] "${a.label}"`);
  for (const p of problems)
    console.log(`  [problem] "${p.label}"  maturity=${p.problemMaturity}  sev=${p.severitySignal ?? "null"}  freq=${p.frequencySignal ?? "null"}`);

  // CA
  const solutions = await prisma.existingSolution.findMany({ where: { pipelineRunId: runId, status: "active" } });
  console.log(`\n── Competitive Analysis: ${solutions.length} existing solution(s) ──`);
  for (const s of solutions) console.log(`  [solution] "${s.label}"  mktShare=${s.estimatedMarketShare ?? "n/a"}  positioning=${(s.positioningSummary ?? "").slice(0, 80)}`);

  // Hypothesis
  const hypotheses = await prisma.hypothesis.findMany({ where: { pipelineRunId: runId, status: "active" } });
  console.log(`\n── Hypothesis: ${hypotheses.length} row(s) ──`);
  for (const h of hypotheses) console.log(`  [hypothesis] "${h.label ?? h.statement.slice(0, 120)}..."  gapType=${h.gapType}`);

  // Composition → Scoring → Confidence
  const candidate = await prisma.opportunityCandidate.findFirst({
    where: { runId, status: "candidate" },
    orderBy: { createdAt: "desc" },
  });
  if (!candidate) {
    console.log("\n── No OpportunityCandidate produced (composition was skipped or failed) ──");
  } else {
    console.log(`\n── OpportunityCandidate ${candidate.id.slice(0, 8)} ──`);
    console.log(`  opportunityQuality   = ${candidate.opportunityQuality ?? "null"}`);
    console.log(`  founderFitScore      = ${candidate.founderFitScore ?? "null"}`);
    console.log(`  ventureScore         = ${candidate.ventureScore ?? "null"}`);
    console.log(`  confidenceScore      = ${candidate.confidenceScore ?? "null"}`);
    console.log(`  coverageGate         = ${candidate.confidenceCoverageGate ?? "null"}`);
    console.log(`  incompleteComposition= ${candidate.incompleteComposition ?? "null"}`);
  }

  // Promoted opportunity
  const opp = candidate
    ? await prisma.opportunity.findUnique({ where: { promotedFromCandidateId: candidate.id } })
    : null;
  if (!opp) {
    console.log("\n── No Opportunity promoted (gate not met or compression skipped) ──");
    if (candidate) {
      console.log(`  ventureScore=${candidate.ventureScore ?? "null"} founderFitScore=${candidate.founderFitScore ?? "null"}`);
      console.log("  Check compression logs for gate reason.");
    }
  } else {
    console.log(`\n╔══ OPPORTUNITY PROMOTED  id=${opp.id.slice(0, 8)} ══`);
    console.log(`║  ventureScore     = ${opp.ventureScore}`);
    console.log(`║  confidenceScore  = ${opp.confidenceScore}`);
    console.log(`║  founderFitScore  = ${opp.founderFitScore}`);
    console.log(`║  rationaleBullets:`);
    for (const b of opp.rationaleBullets) console.log(`║    • ${b}`);
    console.log(`║  riskSummary:`);
    for (const r of opp.riskSummary) console.log(`║    ⚠ ${r}`);
    console.log("╚══");
  }

  // DAG checkpoint summary
  const checkpoints = await prisma.dagRunState.findMany({ where: { runId }, orderBy: { step: "asc" } });
  console.log(`\n── DAG checkpoints ──`);
  for (const c of checkpoints)
    console.log(`  ${c.step.padEnd(20)} ${c.status}${c.lastError ? "  ERR: " + c.lastError.slice(0, 80) : ""}`);
}

// Reset prior run state so a fresh run is forced. Deletes dag_run_state rows
// for B2B_TRACKING_KEY plus all associated pipeline artifacts (scoped to b2b
// runIds — never touches shopify data).
async function resetPriorRuns(): Promise<void> {
  const priorRows = await prisma.dagRunState.findMany({ where: { hypothesisId: B2B_TRACKING_KEY } });
  const priorRunIds = [...new Set(priorRows.map((r) => r.runId))];
  if (priorRunIds.length === 0) return;
  console.log(`[b2b] resetting ${priorRunIds.length} prior run(s): ${priorRunIds.join(", ")}`);
  for (const runId of priorRunIds) {
    await prisma.opportunityCandidate.deleteMany({ where: { runId } });
    await prisma.hypothesis.deleteMany({ where: { pipelineRunId: runId } });
    await prisma.problem.deleteMany({ where: { pipelineRunId: runId } });
    await prisma.audience.deleteMany({ where: { pipelineRunId: runId } });
    await prisma.market.deleteMany({ where: { pipelineRunId: runId } });
    // pipelineRun left in place — agent_execution_log has a FK on run_id.
  }
  await prisma.dagRunState.deleteMany({ where: { hypothesisId: B2B_TRACKING_KEY } });
  console.log(`[b2b] prior run state cleared.`);
}

// Seed a "Customer Support Software" market if one isn't already present for
// this run. Discovery is non-deterministic and sometimes omits it; pre-seeding
// guarantees expansion's categoryTags filter finds it.
async function ensureCustomerSupportMarket(runId: string): Promise<void> {
  const existing = await prisma.market.findFirst({
    where: { pipelineRunId: runId, categoryTags: { hasSome: ["customer support"] } },
  });
  if (existing) return;
  await prisma.market.create({
    data: {
      label: "Customer Support Software",
      maturityStage: "mature",
      confidence: 0.8,
      categoryTags: ["SaaS", "customer support"],
      status: "active",
      pipelineRunId: runId,
    },
  });
  console.log(`[b2b] seeded "Customer Support Software" market for runId=${runId}`);
}

async function main() {
  // Resolve founderId
  const founder = await prisma.founder.findFirst();
  if (!founder) throw new Error("No founder row in DB — run seeding first.");
  console.log(`[b2b] founder=${founder.id}  industries=${founder.industries.join(",")}`);

  // Verify scoring config
  const sc = await prisma.scoringConfig.findFirst({ where: { vertical: VERTICAL } });
  if (!sc) throw new Error(`No scoring_config for vertical="${VERTICAL}" — seed it first.`);
  console.log(`[b2b] scoringConfig found (vertical=${VERTICAL})`);

  // Force fresh run by clearing prior state
  await resetPriorRuns();

  // Start server + workers
  const server = await startServer();
  const base = `http://localhost:${server.port}`;
  console.log(`[b2b] server started at ${base}`);

  process.on("SIGINT", async () => {
    await server.stop();
    await prisma.$disconnect();
    process.exit(0);
  });

  // Fire the orchestrate endpoint
  console.log(`[b2b] POST ${base}/hypotheses/${B2B_TRACKING_KEY}/orchestrate`);
  const orchRes = await fetch(`${base}/hypotheses/${B2B_TRACKING_KEY}/orchestrate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ founderId: founder.id, vertical: VERTICAL }),
  });
  if (!orchRes.ok) throw new Error(`orchestrate failed: ${orchRes.status} ${await orchRes.text()}`);
  const orchBody = await orchRes.json() as { runId: string; isNewRun: boolean; resumedFrom: string };
  console.log(`[b2b] runId=${orchBody.runId}  isNewRun=${orchBody.isNewRun}  resumedFrom=${orchBody.resumedFrom}`);

  // Pre-seed the "Customer Support Software" market so expansion always has
  // a customer-support-tagged market to work against, regardless of what
  // discovery produces.
  await ensureCustomerSupportMarket(orchBody.runId);

  // Poll to completion
  await poll(base, B2B_TRACKING_KEY);

  // Report
  await report(orchBody.runId);

  await server.stop();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
