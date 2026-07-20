// End-to-end integration test for the Phase 6 Orchestrator's wiring.
//
// Scope of THIS test (structural wiring — no live LLM/Tavily calls):
//   - BullMQ queues + workers + sequencing.advance chain the DAG
//   - A step's completed event enqueues the next step
//   - dag_run_state transitions pending → running → succeeded
//   - The Filtering handler deprecates NULL-confidence rows through the
//     live agent path — explicitly covering the previously-flagged gap
//     that "Filtering's threshold=0.5 gate was never exercised on live
//     NULL-confidence output" (task spec, step 7)
//
// The FULL 12-stage LLM-driven traversal is exercised separately in
// step 8 (real live run via the running HTTP server + curl). Baking
// that whole path into an in-repo test would make CI depend on live
// NIM + Tavily availability and cost per run — not appropriate for a
// unit-runner test.
//
// The test does verify the wiring through Filtering → CompetitiveAnalysis
// end-to-end via BullMQ, which is what "the Orchestrator sequences the
// DAG" fundamentally means.
//
// Run: npx tsx -r dotenv/config src/orchestrator/__tests__/endToEndIntegration.test.ts
import { prisma } from "../../db/client";
import { startWorkers, stopWorkers } from "../worker";
import { enqueueStep } from "../sequencing";
import * as checkpoint from "../checkpoint.repository";
import { getQueue, closeAll } from "../queues";
import { DAG_STEPS } from "../steps";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";
const TAG = "test-e2e-orch-";
const HYPOTHESIS_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "✓" : "✗ FAIL"} ${label}`);
  if (!cond) failures++;
}

// Sleep helper for polling — the alternative (QueueEvents wait) adds
// listener plumbing we'd need to tear down; polling on the checkpoint
// row is what an operator does with the /status endpoint anyway.
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStep(runId: string, step: Parameters<typeof checkpoint.getRow>[1], timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await checkpoint.getRow(runId, step);
    if (row?.status === "succeeded" || row?.status === "failed_permanent") return row;
    await sleep(200);
  }
  throw new Error(`timeout waiting for step=${step} on run=${runId}`);
}

const seededMarketIds: string[] = [];
const seededProblemIds: string[] = [];
const seededAudienceIds: string[] = [];

async function seedNullConfidenceRows() {
  // Market with confidence=NULL — Filtering must deprecate.
  // pipelineRunId required: filteringAgent scopes reads to the run's
  // own nodes (migration 009), so nodes without it are invisible to the agent.
  const m = await prisma.market.create({
    data: {
      label: TAG + "null-conf-market",
      marketSizeEstimate: null,
      growthRateEstimate: null,
      maturityStage: "emerging",
      confidence: null, // the explicit NULL under test
      status: "active",
      pipelineRunId: RUN_ID,
    },
  });
  seededMarketIds.push(m.id);

  const a = await prisma.audience.create({
    data: {
      label: TAG + "null-conf-audience",
      willingnessToPaySignal: null,
      acquisitionChannelsKnown: [],
      confidence: null,
      status: "active",
      pipelineRunId: RUN_ID,
    },
  });
  seededAudienceIds.push(a.id);

  const p = await prisma.problem.create({
    data: {
      label: TAG + "null-conf-problem",
      severitySignal: null,
      frequencySignal: null,
      problemMaturity: "emerging",
      confidence: null,
      status: "active",
      pipelineRunId: RUN_ID,
    },
  });
  seededProblemIds.push(p.id);
}

async function cleanup() {
  await prisma.dagRunState.deleteMany({
    where: { runId: RUN_ID, hypothesisId: HYPOTHESIS_ID_PLACEHOLDER },
  });
  if (seededMarketIds.length > 0) await prisma.market.deleteMany({ where: { id: { in: seededMarketIds } } });
  if (seededAudienceIds.length > 0)
    await prisma.audience.deleteMany({ where: { id: { in: seededAudienceIds } } });
  if (seededProblemIds.length > 0)
    await prisma.problem.deleteMany({ where: { id: { in: seededProblemIds } } });
}

async function main() {
  // Ensure any prior test run's checkpoint rows for our placeholder id
  // are gone before we assert on the fresh transitions.
  await prisma.dagRunState.deleteMany({
    where: { runId: RUN_ID, step: { in: ["filtering", "competitive_analysis"] } },
  });

  // Drain any residual jobs from a prior test run so waitForStep only
  // sees this run's completions.
  const fq = getQueue("filtering");
  const caq = getQueue("competitive_analysis");
  await fq.obliterate({ force: true });
  await caq.obliterate({ force: true });

  await seedNullConfidenceRows();

  const workers = startWorkers();
  // Worker count follows DAG_STEPS.length, currently 13 (12 stages +
  // opportunity_rationale post-terminal polish).
  check(
    workers.length === DAG_STEPS.length,
    `startWorkers boots ${DAG_STEPS.length} workers (got ${workers.length})`
  );

  try {
    // Snapshot the seeded rows' statuses BEFORE enqueue so we can
    // assert they transitioned to deprecated.
    const beforeMarket = await prisma.market.findUnique({ where: { id: seededMarketIds[0] } });
    check(beforeMarket?.status === "active", "seeded market starts active");
    check(beforeMarket?.confidence === null, "seeded market has confidence=NULL");

    // ---- Enqueue Filtering directly via the sequencing layer.
    const jobData = {
      runId: RUN_ID,
      hypothesisId: HYPOTHESIS_ID_PLACEHOLDER,
    };
    const enqueueRes = await enqueueStep("filtering", jobData);
    check(enqueueRes.enqueued, "filtering step enqueued");

    // ---- Wait for Filtering to complete.
    const filteringRow = await waitForStep(RUN_ID, "filtering", 45000);
    check(filteringRow?.status === "succeeded", `filtering succeeded (got: ${filteringRow?.status})`);
    check(
      (filteringRow?.attemptCount ?? 0) >= 1,
      `filtering attempt_count incremented (got: ${filteringRow?.attemptCount})`
    );

    // ---- Assert NULL-confidence rows got deprecated. This is the
    // previously-flagged gap coverage: the live threshold=0.5 gate is
    // exercised against actual NULL-confidence rows in production DB.
    const afterMarket = await prisma.market.findUnique({ where: { id: seededMarketIds[0] } });
    const afterProblem = await prisma.problem.findUnique({ where: { id: seededProblemIds[0] } });
    const afterAudience = await prisma.audience.findUnique({ where: { id: seededAudienceIds[0] } });
    check(
      afterMarket?.status === "deprecated",
      `NULL-confidence market DEPRECATED (Filtering threshold=0.5 gate on live NULL — the previously-flagged gap coverage) — got status=${afterMarket?.status}`
    );
    check(
      afterProblem?.status === "deprecated",
      `NULL-confidence problem DEPRECATED (same gap) — got status=${afterProblem?.status}`
    );
    check(
      afterAudience?.status === "deprecated",
      `NULL-confidence audience DEPRECATED (same gap) — got status=${afterAudience?.status}`
    );

    // ---- Assert sequencing enqueued the next linear step.
    // Poll for the competitive_analysis checkpoint row to appear.
    let caRow: checkpoint.CheckpointRow | null = null;
    const seqStart = Date.now();
    while (Date.now() - seqStart < 10000) {
      caRow = await checkpoint.getRow(RUN_ID, "competitive_analysis");
      if (caRow) break;
      await sleep(200);
    }
    check(caRow !== null, "next step (competitive_analysis) checkpoint row created by sequencing");
    // The CA handler may skip (if no problemId available from placeholder
    // context) or succeed depending on prior state — either way, the
    // wiring reached it, which is what this assert covers.
  } finally {
    await stopWorkers();
    await closeAll();
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await stopWorkers().catch(() => {});
  await closeAll().catch(() => {});
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
