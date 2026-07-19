// Hit-rate study driver — runs the shopify_subscriptions vertical against 6
// pre-provisioned founder rows (P1-P6) and reports per-profile score/promotion
// outcomes.
//
// Bypasses the HTTP orchestrate endpoint (which requires Supabase JWT auth AND
// derives founderId from the auth session, making it impossible to drive 6
// different founders from one caller). Instead:
//   1. startWorkers() brings up the BullMQ workers in-process.
//   2. Per profile: reset prior study state, create a pipeline_run row bound
//      to that founderId + vertical, then enqueueStep("discovery", ...).
//      This mirrors what the HTTP endpoint's own success path does.
//   3. Poll dag_run_state directly for progress.
//   4. Sequential — enforces a 5-min minimum floor between successive
//      orchestrate calls so back-to-back runs don't stack against the NIM
//      rolling-window rate limit even with the process-wide guards in place.
//
// Run: npx tsx --env-file=.env src/scripts/runHitRateStudy.ts

import { prisma } from "../db/client";
import { startWorkers, stopWorkers } from "../orchestrator/worker";
import { enqueueStep } from "../orchestrator/sequencing";
import { DAG_STEPS, JOIN_STEP, type DagStep } from "../orchestrator/steps";
import { getQueue } from "../orchestrator/queues";
import * as fs from "node:fs";
import * as path from "node:path";

const VERTICAL = "shopify_subscriptions";
const POLL_INTERVAL_MS = 8_000;
const RUN_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_INTER_PROFILE_START_GAP_MS = 5 * 60 * 1_000;

const P4_HISTORICAL = {
  opportunityQuality: 0.46,
  confidenceScore: 1.0,
  founderFitScore: 20,
  promoted: false,
};

interface Profile {
  key: string;
  description: string;
  trackingKey: string;
  founderId: string;
}

const PROFILES: Profile[] = [
  {
    key: "P1",
    description: "Strong technical (full-stack) + existing SaaS audience + funded",
    trackingKey: "f17e0001-0000-0000-0000-000000000001",
    founderId: "a94e0c97-7844-4e87-9c7f-5d79e16b948e",
  },
  {
    key: "P2",
    description: "Non-technical marketing + no channels + bootstrapped",
    trackingKey: "f17e0001-0000-0000-0000-000000000002",
    founderId: "4ca210f3-9d01-4a11-bc73-40ef510b8433",
  },
  {
    key: "P3",
    description: "Ecommerce operator + Shopify audience + bootstrapped",
    trackingKey: "f17e0001-0000-0000-0000-000000000003",
    founderId: "7e0d92d1-24f0-4fd1-a03a-b84420674d4d",
  },
  {
    key: "P4",
    description: "Generic SaaS founder + no channels + still figuring out capital (aae43d53 profile-match)",
    trackingKey: "f17e0001-0000-0000-0000-000000000004",
    founderId: "9f63a7f7-4890-42c1-a44d-552b135a1073",
  },
  {
    key: "P5",
    description: "Strong distribution (VP Growth) + weak technical + funded",
    trackingKey: "f17e0001-0000-0000-0000-000000000005",
    founderId: "a4ba0a10-3d7d-43f6-b5bc-80fc974234e7",
  },
  {
    key: "P6",
    description: "Ex-Shopify PM + no audience yet + funded",
    trackingKey: "f17e0001-0000-0000-0000-000000000006",
    founderId: "690c37bb-16a9-4f70-be0a-93329f8b9a7e",
  },
];

interface ProfileResult {
  profile: Profile;
  runId: string | null;
  startedAt: string;
  finishedAt: string | null;
  wallClockMs: number;
  overallStatus: "completed" | "failed" | "timeout" | "orchestrate_error";
  failedSteps: { step: string; error: string }[];
  numHypotheses: number;
  numCandidates: number;
  candidate: {
    id: string;
    opportunityQuality: number | null;
    founderFitScore: number | null;
    ventureScore: number | null;
    confidenceScore: number | null;
    coverageGate: string | null;
    incompleteComposition: boolean | null;
  } | null;
  promoted: boolean;
  opportunityId: string | null;
  nim504Count: number;
  nimCallCount: number;
  nimTimingMsTotal: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resetPriorRunsForKey(trackingKey: string): Promise<void> {
  // The only reset the orchestrator strictly requires is dropping
  // dag_run_state for this tracking key — otherwise the next
  // orchestrate call resumes from prior checkpoints instead of firing
  // discovery fresh. dag_run_state has no FK children, so this is
  // always safe.
  //
  // The pipeline artifacts (opportunity_candidate, hypothesis, etc.)
  // from the prior run become orphans in the DB but don't interfere
  // with THIS run — each new pipeline_run gets a fresh runId, and
  // collectResult queries by that new id. Best-effort cleanup below,
  // but individual FK failures are logged and swallowed so the study
  // continues rather than chase every child table's FK chain.
  const priorRows = await prisma.dagRunState.findMany({ where: { hypothesisId: trackingKey } });
  const priorRunIds = [...new Set(priorRows.map((r) => r.runId))];
  await prisma.dagRunState.deleteMany({ where: { hypothesisId: trackingKey } });
  if (priorRunIds.length === 0) return;
  console.log(`  [reset] cleared dag_run_state for trackingKey=${trackingKey}; best-effort wiping ${priorRunIds.length} prior run(s)`);
  for (const runId of priorRunIds) {
    try {
      const cands = await prisma.opportunityCandidate.findMany({ where: { runId }, select: { id: true } });
      for (const c of cands) {
        await prisma.opportunity.deleteMany({ where: { promotedFromCandidateId: c.id } }).catch(() => {});
        await prisma.opportunityCandidateComposition.deleteMany({ where: { candidateId: c.id } }).catch(() => {});
      }
      await prisma.agentExecutionLog
        .updateMany({ where: { runId, candidateId: { not: null } }, data: { candidateId: null } })
        .catch(() => {});
      await prisma.opportunityCandidate.deleteMany({ where: { runId } }).catch(() => {});
      await prisma.hypothesis.deleteMany({ where: { pipelineRunId: runId } }).catch(() => {});
      await prisma.problem.deleteMany({ where: { pipelineRunId: runId } }).catch(() => {});
      await prisma.audience.deleteMany({ where: { pipelineRunId: runId } }).catch(() => {});
      await prisma.market.deleteMany({ where: { pipelineRunId: runId } }).catch(() => {});
    } catch (e) {
      console.warn(`  [reset] partial cleanup of runId=${runId} failed (orphans harmless): ${(e as Error).message.slice(0, 100)}`);
    }
  }
}

// Derive overall run status directly from dag_run_state rows for one run.
function deriveOverall(rows: { step: string; status: string }[]): "queued" | "in_progress" | "completed" | "failed" {
  if (rows.some((r) => r.status === "failed_permanent")) return "failed";
  if (rows.some((r) => r.status === "running" || r.status === "pending")) return "in_progress";
  const join = rows.find((r) => r.step === JOIN_STEP);
  if (join?.status === "succeeded") return "completed";
  if (rows.length === 0 || rows.every((r) => r.status === "not_started")) return "queued";
  return "in_progress";
}

async function pollUntilDone(
  runId: string,
  profileKey: string,
): Promise<{ status: "completed" | "failed" | "timeout"; failedSteps: { step: string; error: string }[] }> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let ticks = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    ticks++;
    const rows = await prisma.dagRunState.findMany({
      where: { runId },
      select: { step: true, status: true, lastError: true },
    });
    const overall = deriveOverall(rows);
    const running = rows.filter((r) => r.status === "running").map((r) => r.step);
    const failed = rows.filter((r) => r.status === "failed_permanent");
    if (ticks % 4 === 0) {
      console.log(`  [${profileKey}][poll ${ticks}] overall=${overall}  running=[${running.join(",")}]`);
    }
    if (failed.length > 0) {
      const fs = failed.map((f) => ({ step: f.step, error: f.lastError ?? "" }));
      console.log(`  [${profileKey}] FAILED steps:`, fs.map((f) => f.step).join(","));
      return { status: "failed", failedSteps: fs };
    }
    if (overall === "completed") {
      console.log(`  [${profileKey}] all steps completed`);
      return { status: "completed", failedSteps: [] };
    }
  }
  console.log(`  [${profileKey}] TIMEOUT after 30 min`);
  return { status: "timeout", failedSteps: [] };
}

async function collectResult(
  profile: Profile,
  runId: string | null,
  wallClockMs: number,
  startedAt: string,
  finishedAt: string,
  overallStatus: ProfileResult["overallStatus"],
  failedSteps: { step: string; error: string }[],
): Promise<ProfileResult> {
  const base: ProfileResult = {
    profile,
    runId,
    startedAt,
    finishedAt,
    wallClockMs,
    overallStatus,
    failedSteps,
    numHypotheses: 0,
    numCandidates: 0,
    candidate: null,
    promoted: false,
    opportunityId: null,
    nim504Count: 0,
    nimCallCount: 0,
    nimTimingMsTotal: 0,
  };
  if (!runId) return base;

  const [hypotheses, candidates] = await Promise.all([
    prisma.hypothesis.count({ where: { pipelineRunId: runId, status: "active" } }),
    prisma.opportunityCandidate.findMany({ where: { runId }, orderBy: { createdAt: "desc" } }),
  ]);
  base.numHypotheses = hypotheses;
  base.numCandidates = candidates.length;

  const cand = candidates[0];
  if (cand) {
    // ventureScore lives on the promoted Opportunity row, NOT on the
    // OpportunityCandidate — compressionAgent.ts:296 writes it there
    // when the promotion transaction commits. Prior driver read from
    // the candidate row (always null in DB) and mis-reported. Look up
    // opportunity here and pull ventureScore from it if present.
    const opp = await prisma.opportunity.findUnique({ where: { promotedFromCandidateId: cand.id } });
    base.candidate = {
      id: cand.id,
      opportunityQuality: cand.opportunityQuality,
      founderFitScore: cand.founderFitScore,
      ventureScore: opp?.ventureScore ?? null,
      confidenceScore: cand.confidenceScore,
      coverageGate: (cand as any).confidenceCoverageGate ?? null,
      incompleteComposition: (cand as any).incompleteComposition ?? null,
    };
    if (opp) {
      base.promoted = true;
      base.opportunityId = opp.id;
    }
  }

  try {
    // Correct schema — no latencyMs/statusCode fields. Compute latency
    // from startedAt/completedAt; scan status + rawOutput for 504.
    const logs = await prisma.agentExecutionLog.findMany({
      where: { runId },
      select: { agentName: true, startedAt: true, completedAt: true, status: true, rawOutput: true, attemptNumber: true },
      orderBy: { startedAt: "asc" },
    });
    base.nimCallCount = logs.length;
    base.nimTimingMsTotal = logs.reduce((acc, l) => {
      const start = l.startedAt ? new Date(l.startedAt).getTime() : 0;
      const end = l.completedAt ? new Date(l.completedAt).getTime() : 0;
      return acc + (start && end && end > start ? end - start : 0);
    }, 0);
    base.nim504Count = logs.filter((l) => {
      const raw = typeof l.rawOutput === "string" ? l.rawOutput : JSON.stringify(l.rawOutput ?? "");
      return raw.includes("504") || raw.toLowerCase().includes("gateway timeout") || (l.status === "failed" && (raw.includes("NIM") || raw.includes("nemotron")));
    }).length;
  } catch (e) {
    console.warn(`  [${profile.key}] agent_execution_log scan skipped: ${(e as Error).message}`);
  }

  return base;
}

function fmtScore(n: number | null | undefined): string {
  return n === null || n === undefined ? "  n/a " : n.toFixed(3).padStart(6);
}

function summarize(nums: (number | null | undefined)[]): { min: number; max: number; median: number; n: number } | null {
  const clean = nums.filter((n): n is number => typeof n === "number");
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min: sorted[0], max: sorted[sorted.length - 1], median, n: sorted.length };
}

function printReport(results: ProfileResult[], startAt: Date, endAt: Date): void {
  const wallMs = endAt.getTime() - startAt.getTime();
  const wallMin = (wallMs / 60_000).toFixed(1);
  const totalNimMs = results.reduce((a, r) => a + r.nimTimingMsTotal, 0);
  const totalNimCalls = results.reduce((a, r) => a + r.nimCallCount, 0);
  const total504s = results.reduce((a, r) => a + r.nim504Count, 0);
  const promoted = results.filter((r) => r.promoted).length;
  const withCandidate = results.filter((r) => r.candidate).length;

  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════════════");
  console.log(`  HIT-RATE STUDY REPORT  (vertical=${VERTICAL})`);
  console.log(`  start=${startAt.toISOString()}  end=${endAt.toISOString()}`);
  console.log(`  wall clock: ${wallMin} min`);
  console.log("═══════════════════════════════════════════════════════════════════════════");

  console.log("\n── Per-Profile Results ──");
  console.log("key | status         | #hyp | #cand | oppQ   | conf   | fit    | ventS  | promoted | 504s");
  console.log("----+----------------+------+-------+--------+--------+--------+--------+----------+-----");
  for (const r of results) {
    const c = r.candidate;
    console.log(
      [
        r.profile.key.padEnd(4),
        r.overallStatus.padEnd(14),
        String(r.numHypotheses).padStart(4),
        String(r.numCandidates).padStart(5),
        fmtScore(c?.opportunityQuality ?? null),
        fmtScore(c?.confidenceScore ?? null),
        fmtScore(c?.founderFitScore ?? null),
        fmtScore(c?.ventureScore ?? null),
        (r.promoted ? "YES" : "no").padEnd(8),
        String(r.nim504Count).padStart(4),
      ].join(" | "),
    );
  }

  console.log(`\n── Promotion Rate ──`);
  console.log(`  ${promoted} / 6 profiles promoted  (${((promoted / 6) * 100).toFixed(0)}%)`);
  console.log(`  ${withCandidate} / 6 produced a candidate`);

  console.log(`\n── Score Distribution ──`);
  const s = (label: string, xs: (number | null | undefined)[]) => {
    const stats = summarize(xs);
    if (!stats) {
      console.log(`  ${label}: no data`);
    } else {
      console.log(`  ${label.padEnd(20)} n=${stats.n}  min=${stats.min.toFixed(3)}  median=${stats.median.toFixed(3)}  max=${stats.max.toFixed(3)}`);
    }
  };
  s("opportunityQuality", results.map((r) => r.candidate?.opportunityQuality ?? null));
  s("confidenceScore", results.map((r) => r.candidate?.confidenceScore ?? null));
  s("founderFitScore", results.map((r) => r.candidate?.founderFitScore ?? null));
  s("ventureScore", results.map((r) => r.candidate?.ventureScore ?? null));

  console.log(`\n── FounderFit Expectation Check ──`);
  console.log(`  Prior expectation: P1/P3/P6 (technical/domain fit for shopify subs) score higher than P2/P4/P5.`);
  const groupExpectedHigh = ["P1", "P3", "P6"];
  const groupExpectedLow = ["P2", "P4", "P5"];
  const fitOf = (key: string) => results.find((r) => r.profile.key === key)?.candidate?.founderFitScore ?? null;
  for (const k of groupExpectedHigh) console.log(`  ${k} (expected HIGH): fit=${fmtScore(fitOf(k))}`);
  for (const k of groupExpectedLow) console.log(`  ${k} (expected LOW):  fit=${fmtScore(fitOf(k))}`);

  const highs = groupExpectedHigh.map(fitOf).filter((n): n is number => typeof n === "number");
  const lows = groupExpectedLow.map(fitOf).filter((n): n is number => typeof n === "number");
  if (highs.length && lows.length) {
    const avgHigh = highs.reduce((a, b) => a + b, 0) / highs.length;
    const avgLow = lows.reduce((a, b) => a + b, 0) / lows.length;
    console.log(`  avg(high group) = ${avgHigh.toFixed(2)}   avg(low group) = ${avgLow.toFixed(2)}   Δ = ${(avgHigh - avgLow).toFixed(2)}`);
    console.log(`  ${avgHigh > avgLow ? "PASS" : "FAIL"} — founderFit ${avgHigh > avgLow ? "does" : "does NOT"} respond in expected direction`);
  }

  console.log(`\n── P4 vs aae43d53 historical baseline ──`);
  const p4 = results.find((r) => r.profile.key === "P4");
  console.log(`  Historical aae43d53:  oppQ=${P4_HISTORICAL.opportunityQuality}  conf=${P4_HISTORICAL.confidenceScore}  fit=${P4_HISTORICAL.founderFitScore}  promoted=${P4_HISTORICAL.promoted}`);
  if (p4?.candidate) {
    console.log(`  This-run P4:          oppQ=${p4.candidate.opportunityQuality ?? "n/a"}  conf=${p4.candidate.confidenceScore ?? "n/a"}  fit=${p4.candidate.founderFitScore ?? "n/a"}  promoted=${p4.promoted}`);
  } else {
    console.log(`  This-run P4:          no candidate produced (status=${p4?.overallStatus})`);
  }

  console.log(`\n── NIM Traffic ──`);
  console.log(`  total NIM calls (via agent_execution_log): ${totalNimCalls}`);
  console.log(`  total NIM latency: ${(totalNimMs / 60_000).toFixed(2)} min`);
  console.log(`  504 count: ${total504s}`);
  console.log(`  ${total504s === 0 ? "PASS" : "FAIL"} — NIM guards + 5-min pacing ${total504s === 0 ? "held under load" : "did NOT prevent 504s"}`);

  console.log(`\n── Failed Steps by Profile ──`);
  for (const r of results) {
    if (r.failedSteps.length > 0) {
      console.log(`  ${r.profile.key}:`);
      for (const f of r.failedSteps) console.log(`    ${f.step}  err=${f.error.slice(0, 120)}`);
    }
  }
  console.log("═══════════════════════════════════════════════════════════════════════════\n");
}

async function runOneProfile(profile: Profile): Promise<ProfileResult> {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  console.log(`\n──── ${profile.key} ──── ${profile.description}`);
  console.log(`  trackingKey=${profile.trackingKey}  founderId=${profile.founderId}`);

  await resetPriorRunsForKey(profile.trackingKey);

  let runId: string;
  try {
    const run = await prisma.pipelineRun.create({
      data: { founderId: profile.founderId, vertical: VERTICAL },
    });
    runId = run.runId;
    console.log(`  [${profile.key}] created pipeline_run runId=${runId}`);

    const jobData = {
      runId,
      hypothesisId: profile.trackingKey,
      marketId: undefined,
      problemId: undefined,
    };
    const enq = await enqueueStep("discovery" as DagStep, jobData);
    if (!enq.enqueued) {
      throw new Error(`enqueueStep returned enqueued=false reason=${enq.reason ?? "unknown"}`);
    }
    console.log(`  [${profile.key}] enqueued discovery step`);
  } catch (e) {
    const err = e as Error;
    console.error(`  [${profile.key}] orchestrate error:`, err.message);
    return collectResult(profile, null, 0, startedAtIso, new Date().toISOString(), "orchestrate_error", [
      { step: "orchestrate", error: err.message },
    ]);
  }

  const pollResult = await pollUntilDone(runId, profile.key);
  const finishedAt = new Date();

  const result = await collectResult(
    profile,
    runId,
    finishedAt.getTime() - startedAt.getTime(),
    startedAtIso,
    finishedAt.toISOString(),
    pollResult.status,
    pollResult.failedSteps,
  );

  const c = result.candidate;
  console.log(
    `  [${profile.key}] hypotheses=${result.numHypotheses}  candidates=${result.numCandidates}  promoted=${result.promoted}  scores(oppQ/conf/fit/vent)=${fmtScore(c?.opportunityQuality)} / ${fmtScore(c?.confidenceScore)} / ${fmtScore(c?.founderFitScore)} / ${fmtScore(c?.ventureScore)}`,
  );
  return result;
}

async function main() {
  console.log("═════════════════════════════════════");
  console.log("  HIT-RATE STUDY  (P1-P6, shopify_subscriptions)");
  console.log("═════════════════════════════════════");

  const sc = await prisma.scoringConfig.findFirst({ where: { vertical: VERTICAL } });
  if (!sc) throw new Error(`No scoring_config for vertical="${VERTICAL}"`);
  console.log(`[setup] scoring_config for ${VERTICAL}: present`);

  for (const profile of PROFILES) {
    const founder = await prisma.founder.findUnique({ where: { id: profile.founderId } });
    if (!founder) throw new Error(`Profile ${profile.key}: founderId ${profile.founderId} not found`);
  }
  console.log(`[setup] all 6 founder rows resolved`);

  // Obliterate any leftover BullMQ jobs from prior sessions BEFORE
  // starting workers. Prior study runs that errored mid-flight leave
  // orphaned jobs in Redis whose dag_run_state rows have been deleted
  // by the reset. If left, they compete with study jobs on the
  // concurrency=1 discovery worker (observed: P1 stuck 11+ min while
  // an orphaned P2025-failing job burned through its retry budget).
  for (const step of DAG_STEPS) {
    try {
      await getQueue(step).obliterate({ force: true });
    } catch (e) {
      console.warn(`  [drain] queue=${step} obliterate failed (non-fatal): ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log(`[setup] drained all ${DAG_STEPS.length} queues`);

  startWorkers();
  console.log(`[setup] workers started (${DAG_STEPS.length} queues)`);

  const cleanup = async () => {
    try {
      await stopWorkers();
    } catch {}
    await prisma.$disconnect();
  };
  process.on("SIGINT", async () => {
    console.log("\n[SIGINT] shutting down");
    await cleanup();
    process.exit(130);
  });

  const studyStart = new Date();
  const results: ProfileResult[] = [];

  for (let i = 0; i < PROFILES.length; i++) {
    const profile = PROFILES[i];
    const orchestrateStart = Date.now();
    try {
      const result = await runOneProfile(profile);
      results.push(result);
    } catch (e) {
      console.error(`  [${profile.key}] uncaught error:`, e);
      results.push(
        await collectResult(profile, null, 0, new Date(orchestrateStart).toISOString(), new Date().toISOString(), "orchestrate_error", [
          { step: "driver", error: (e as Error).message },
        ]),
      );
    }

    const outPath = path.resolve(process.cwd(), "hitRateStudyResults.json");
    fs.writeFileSync(outPath, JSON.stringify({ studyStart, results }, null, 2));
    console.log(`  [${profile.key}] partial results written → ${outPath}`);

    if (i < PROFILES.length - 1) {
      const elapsed = Date.now() - orchestrateStart;
      const remaining = MIN_INTER_PROFILE_START_GAP_MS - elapsed;
      if (remaining > 0) {
        console.log(`  [pacing] elapsed=${(elapsed / 1000).toFixed(0)}s < 5min floor — sleeping ${(remaining / 1000).toFixed(0)}s`);
        await sleep(remaining);
      } else {
        console.log(`  [pacing] elapsed=${(elapsed / 1000).toFixed(0)}s ≥ 5min floor — proceeding immediately`);
      }
    }
  }

  const studyEnd = new Date();
  printReport(results, studyStart, studyEnd);

  const outPath = path.resolve(process.cwd(), "hitRateStudyResults.json");
  fs.writeFileSync(outPath, JSON.stringify({ studyStart, studyEnd, results }, null, 2));
  console.log(`\n[done] full results written → ${outPath}`);

  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await stopWorkers();
  } catch {}
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
