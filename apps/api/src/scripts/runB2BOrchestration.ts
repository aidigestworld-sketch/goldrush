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
import { enqueueStep } from "../orchestrator/sequencing";

const VERTICAL = "b2b_customer_support_saas";
// Stable tracking key — stored as hypothesis_id in dag_run_state.
// Changing this forces a new run; keeping it stable lets re-runs resume.
const B2B_TRACKING_KEY = "b2b00000-0000-0000-0000-000000000001";
const POLL_INTERVAL_MS = 8_000;
const TIMEOUT_MS = 30 * 60 * 1_000; // 30 min hard stop
// Per-step ceiling. Legit worst case ≈ 15-min NIM attempt + 5s BullMQ
// backoff + partial second attempt. 20 min sits above that but well
// under the whole-run cap so a truly-wedged step is caught within
// ~10 min of hanging past its normal 2–9 min window.
const STEP_TIMEOUT_MS = 20 * 60 * 1_000;
// Cap on how long the shutdown path itself will wait. BullMQ's
// Worker.close() waits for in-flight jobs to drain (which can hang if
// a job is stuck in a slow NIM call); prisma.$disconnect() can also
// hang. Wrap both in a timeout so the process exits promptly.
const SHUTDOWN_TIMEOUT_MS = 15_000;

function ts(): string {
  return new Date().toISOString();
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return await Promise.race([
    p,
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        console.warn(`[${ts()}] [b2b] ${label} exceeded ${ms}ms — proceeding without waiting`);
        resolve(undefined);
      }, ms)
    ),
  ]);
}

// Polls dag_run_state directly rather than hitting GET /hypotheses/:id/status,
// which lives behind the auth middleware and would need a Supabase JWT the
// script can't produce. All the info the endpoint returns is derivable from
// dag_run_state + pipeline_run — this is what the endpoint reads anyway.
async function poll(runId: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let tick = 0;

  // Per-step observed state for transition + retry detection between polls.
  // Keyed by step name.
  type StepSnapshot = { status: string; attemptCount: number; startedAt: Date | null };
  const seen = new Map<string, StepSnapshot>();

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    tick++;
    const [rows, run] = await Promise.all([
      prisma.dagRunState.findMany({ where: { runId } }),
      prisma.pipelineRun.findUnique({ where: { runId } }),
    ]);

    // ── Step transition + retry detection ─────────────────────────────
    for (const r of rows) {
      const prev = seen.get(r.step);
      if (!prev) {
        // First time we've seen this step row.
        if (r.status === "running") {
          console.log(`[${ts()}] STEP START   step=${r.step}  attempt=${r.attemptCount + 1}`);
        } else if (r.status === "succeeded" || r.status === "failed_permanent") {
          console.log(`[${ts()}] STEP ${r.status.toUpperCase()}   step=${r.step}  (observed already-terminal)`);
        }
      } else {
        if (prev.status !== "running" && r.status === "running") {
          console.log(`[${ts()}] STEP START   step=${r.step}  attempt=${r.attemptCount + 1}`);
        }
        if (prev.status === "running" && r.status === "succeeded") {
          const durMs = r.startedAt ? Date.now() - r.startedAt.getTime() : null;
          console.log(
            `[${ts()}] STEP OK      step=${r.step}  duration=${durMs !== null ? Math.round(durMs / 1000) + "s" : "n/a"}  attempts=${r.attemptCount}`
          );
        }
        if (prev.status === "running" && r.status === "failed_permanent") {
          const durMs = r.startedAt ? Date.now() - r.startedAt.getTime() : null;
          console.error(
            `[${ts()}] STEP FAIL    step=${r.step}  duration=${durMs !== null ? Math.round(durMs / 1000) + "s" : "n/a"}  attempts=${r.attemptCount}  err=${(r.lastError ?? "").slice(0, 200)}`
          );
        }
        // attemptCount growth while still running/pending = a retry event.
        // NIM 504s trigger BullMQ retry — this is where we see it from
        // outside the worker.
        if (r.attemptCount > prev.attemptCount && r.status !== "succeeded") {
          console.warn(
            `[${ts()}] RETRY        step=${r.step}  attempt=${r.attemptCount}  (prev err: ${(r.lastError ?? "").slice(0, 120)})`
          );
        }
      }
      seen.set(r.step, {
        status: r.status,
        attemptCount: r.attemptCount,
        startedAt: r.startedAt,
      });
    }

    const running = rows.filter((r) => r.status === "running");
    const failed = rows.filter((r) => r.status === "failed_permanent");
    const succeeded = rows.filter((r) => r.status === "succeeded").length;
    const joinRow = rows.find((r) => r.step === "compression");

    // Ticker on its own line with a wall-clock timestamp — a frozen
    // ticker is visually obvious (same "tick=" value with an old
    // timestamp) vs. one that's polling but seeing no progress
    // (increasing tick + fresh timestamp + same running set).
    console.log(
      `[${ts()}] TICK ${tick}  succeeded=${succeeded}/${rows.length}  running=[${running.map((r) => r.step).join(",")}]  pr_status=${run?.status ?? "?"}`
    );

    // Per-step timeout: any step that's been in `running` longer than
    // STEP_TIMEOUT_MS is treated as wedged. Mark it failed_permanent so
    // downstream state is coherent and abort the poll.
    for (const r of running) {
      if (!r.startedAt) continue;
      const elapsedMs = Date.now() - r.startedAt.getTime();
      if (elapsedMs > STEP_TIMEOUT_MS) {
        const msg = `STEP TIMEOUT: ${r.step} exceeded ${Math.round(STEP_TIMEOUT_MS / 1000)}s (actual ${Math.round(elapsedMs / 1000)}s)`;
        console.error(`[${ts()}] ${msg}`);
        await prisma.dagRunState.update({
          where: { id: r.id },
          data: { status: "failed_permanent", lastError: msg, completedAt: new Date() },
        });
        console.error(`[${ts()}] Marked step=${r.step} failed_permanent in dag_run_state. Halting poll.`);
        return;
      }
    }

    if (failed.length > 0) {
      for (const f of failed) console.error(`[${ts()}] FAILED step=${f.step}  error=${(f.lastError ?? "").slice(0, 200)}`);
      console.log(`[${ts()}] Run halted — partial results shown below.`);
      return;
    }
    // Terminal: compression succeeded (whether it produced an Opportunity or
    // wrote insufficient_evidence — both are legitimate end states).
    if (joinRow?.status === "succeeded") {
      console.log(`[${ts()}] Compression completed  pipeline_run.status=${run?.status}`);
      return;
    }
  }

  console.error(`[${ts()}] WHOLE-RUN TIMEOUT: run did not complete within ${Math.round(TIMEOUT_MS / 60_000)} minutes.`);
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

  // Start server + workers (workers are what actually drain the BullMQ
  // queues we enqueue below — the HTTP server itself isn't strictly
  // needed by this script anymore, but startServer starts both).
  const server = await startServer();
  console.log(`[b2b] server + workers started on port ${server.port}`);

  process.on("SIGINT", async () => {
    console.log(`\n[${ts()}] SIGINT received — shutting down (timeout-guarded)`);
    await withTimeout(server.stop(), SHUTDOWN_TIMEOUT_MS, "server.stop");
    await withTimeout(prisma.$disconnect(), SHUTDOWN_TIMEOUT_MS, "prisma.$disconnect");
    process.exit(0);
  });

  // Kick off the run in-process. The /hypotheses/:id/orchestrate endpoint
  // requires a Supabase JWT (auth middleware — see middleware/auth.ts);
  // scripts can't produce one, so we replicate what the endpoint does
  // (create pipeline_run for this founder+vertical, enqueue the first
  // DAG step) directly against prisma + sequencing. resetPriorRuns above
  // guarantees this is always a fresh run.
  const pipelineRun = await prisma.pipelineRun.create({
    data: { founderId: founder.id, vertical: VERTICAL },
  });
  const runId = pipelineRun.runId;
  console.log(`[b2b] created pipeline_run runId=${runId}  vertical=${VERTICAL}`);
  await enqueueStep("discovery", { runId, hypothesisId: B2B_TRACKING_KEY });
  console.log(`[b2b] enqueued discovery step`);

  // Pre-seed the "Customer Support Software" market so expansion always has
  // a customer-support-tagged market to work against, regardless of what
  // discovery produces.
  await ensureCustomerSupportMarket(runId);

  // Poll to completion (directly against dag_run_state to avoid auth).
  await poll(runId);

  // Report
  await report(runId);

  console.log(`[${ts()}] Shutting down (timeout-guarded)`);
  await withTimeout(server.stop(), SHUTDOWN_TIMEOUT_MS, "server.stop");
  await withTimeout(prisma.$disconnect(), SHUTDOWN_TIMEOUT_MS, "prisma.$disconnect");
  // Force-exit — if a BullMQ worker or Redis handle is still holding
  // the event loop open past the shutdown window, we prefer a clean
  // exit code over hanging.
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await withTimeout(prisma.$disconnect(), SHUTDOWN_TIMEOUT_MS, "prisma.$disconnect");
  process.exit(1);
});
