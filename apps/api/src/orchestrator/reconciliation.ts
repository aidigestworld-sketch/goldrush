// Reconciliation for dag_run_state rows that BullMQ has moved past but
// the DB doesn't know about it — the split-brain class of bug.
//
// Two shapes of split-brain resolved here:
//
//   A) DB `status='running'` with no active BullMQ job at all (the
//      "worker died mid-attempt" case). Handled by falling back to a
//      45-min stale-threshold check when the BullMQ lookup returns
//      "no job", same as the original reconciler.
//
//   B) DB `status IN ('pending', 'running')` while BullMQ has the
//      corresponding job in a TERMINAL state ('failed' or 'completed').
//      This is the specific class the 13:02:44 UTC 2026-07-15 incident
//      hit: `recordAttemptError` ran (row → 'pending', attemptCount=3,
//      lastError populated) but the follow-up `markFailedPermanent`
//      never ran because the process was killed in the 4ms window
//      between the two awaits. Result: row stuck at 'pending' with a
//      BullMQ job in `state=failed`, no worker will ever pick it up
//      because 'failed' is terminal in BullMQ.
//
// Approach: state-driven mirroring. For every stuck-looking DB row,
// look up the BullMQ job by the deterministic jobId (`${runId}-${step}`
// — the shape sequencing.ts enqueues with). If BullMQ says the job is
// terminal, mirror that terminal state to the DB. If BullMQ says the
// job is in flight (waiting/active/delayed), leave the row alone. If
// there's no job in BullMQ at all, fall back to the time-based
// invariant (row must not be 'running' past STALE_THRESHOLD_MS with no
// live evidence).
//
// Runs both at startup (worker.ts's startWorkers) AND on a periodic
// timer (RECONCILE_INTERVAL_MS) so the split-brain doesn't need a
// process restart to resolve.

import { prisma } from "../db/client";
import { getQueue } from "./queues";
import type { DagStep } from "./steps";
import * as checkpoint from "./checkpoint.repository";

// 45 minutes. Per-attempt NIM timeout is 15 min (raised from 10 for
// large max_tokens completions); a fully-retried step with exponential
// backoff (5s → 10s → 20s) worst-case is ~45 min. 45 min gives a
// safe ceiling for legitimate in-flight work — anything past that
// with no BullMQ job is definitively stuck.
export const STALE_THRESHOLD_MS = 45 * 60 * 1000;

// Periodic sweep cadence. 2 minutes: quick enough that a stuck split-
// brain (like the 13:02:44 incident) resolves within a few minutes
// without needing a restart; slow enough that the cost (one query
// finding usually-zero rows) is negligible.
export const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

const CRASHED_MID_ATTEMPT_MESSAGE =
  "Reconciled to failed_permanent: dag_run_state was stuck at 'running' with no active BullMQ job. " +
  "Likely the worker process was killed mid-attempt (SIGKILL, OOM, Docker restart, or Node crash) " +
  "before its on-failed handler could persist the failure. Prior lastError preserved below (if any).";

const BULLMQ_FAILED_MIRROR_MESSAGE =
  "Reconciled to failed_permanent: DB row was stuck at 'pending'/'running' but the corresponding " +
  "BullMQ job is in terminal 'failed' state (attempts exhausted). Split-brain: the worker's " +
  "on('failed') handler ran recordAttemptError but not markFailedPermanent (process likely killed " +
  "in the ~4ms window between the two awaits). BullMQ's failedReason:";

export interface ReconciliationResult {
  scanned: number;
  reconciledFailed: number;
  reconciledSucceeded: number;
  stillActive: number;
  crashedMidAttempt: number;
}

// The DB row shape we work with. Not exported because the row type
// leaks Prisma-generated field names; we normalize what we care about.
interface StuckRow {
  runId: string;
  step: string;
  status: string;
  startedAt: Date | null;
  lastError: string | null;
}

export async function reconcileStuckRunningSteps(now: Date = new Date()): Promise<ReconciliationResult> {
  // Widen the sweep to 'pending' too — the specific bug class the
  // new implementation catches lives there, not just in 'running'.
  const stuck = await prisma.dagRunState.findMany({
    where: { status: { in: ["pending", "running"] } },
    select: {
      runId: true,
      step: true,
      status: true,
      startedAt: true,
      lastError: true,
    },
  });

  const result: ReconciliationResult = {
    scanned: stuck.length,
    reconciledFailed: 0,
    reconciledSucceeded: 0,
    stillActive: 0,
    crashedMidAttempt: 0,
  };

  for (const row of stuck) {
    await reconcileOne(row, now, result);
  }

  return result;
}

async function reconcileOne(row: StuckRow, now: Date, result: ReconciliationResult): Promise<void> {
  const step = row.step as DagStep;
  const jobLookup = await lookupJob(step, row.runId);

  if (jobLookup.error) {
    // Redis unreachable / BullMQ transient — do not reconcile in this
    // pass. A false positive here (marking a live job failed) is worse
    // than leaving the row for the next tick.
    return;
  }

  if (jobLookup.state === null) {
    // No BullMQ job exists at all. Fall back to the time-based invariant.
    // Only fires for 'running' rows past the stale threshold — 'pending'
    // rows with no job might legitimately be waiting for the next
    // upstream step's completed event to enqueue them.
    if (row.status === "running" && row.startedAt && row.startedAt.getTime() < now.getTime() - STALE_THRESHOLD_MS) {
      const errorForStorage = CRASHED_MID_ATTEMPT_MESSAGE + (row.lastError ? `\n\nPrior lastError:\n${row.lastError}` : "");
      await checkpoint.markFailedPermanent(row.runId, step, errorForStorage);
      console.warn(
        `[orchestrator] reconciled crashed-mid-attempt run=${row.runId} step=${row.step} (startedAt=${row.startedAt?.toISOString()}) → failed_permanent`
      );
      result.crashedMidAttempt++;
      result.reconciledFailed++;
    }
    return;
  }

  if (jobLookup.state === "failed") {
    // Mirror BullMQ's terminal failure into the DB.
    const errorForStorage =
      BULLMQ_FAILED_MIRROR_MESSAGE +
      `\n${jobLookup.failedReason ?? "<no failedReason on BullMQ job>"}` +
      (row.lastError ? `\n\nPrior lastError from DB:\n${row.lastError}` : "");
    await checkpoint.markFailedPermanent(row.runId, step, errorForStorage);
    console.warn(
      `[orchestrator] reconciled split-brain run=${row.runId} step=${row.step} DB=${row.status} → failed_permanent (BullMQ=failed)`
    );
    result.reconciledFailed++;
    return;
  }

  if (jobLookup.state === "completed") {
    // Defensive — should not happen (markSucceeded runs inline in the
    // handler before BullMQ marks the job completed), but if the
    // handler somehow returned without markSucceeded firing, mirror
    // the BullMQ terminal.
    await prisma.dagRunState.updateMany({
      where: { runId: row.runId, step },
      data: { status: "succeeded", completedAt: now, updatedAt: now, lastError: null },
    });
    console.warn(
      `[orchestrator] reconciled split-brain run=${row.runId} step=${row.step} DB=${row.status} → succeeded (BullMQ=completed)`
    );
    result.reconciledSucceeded++;
    return;
  }

  // waiting / active / delayed / waiting-children / prioritized — the job
  // is genuinely in flight, leave it alone.
  result.stillActive++;
}

type BullMqStateOrNull =
  | "completed"
  | "failed"
  | "active"
  | "waiting"
  | "delayed"
  | "waiting-children"
  | "prioritized"
  | "unknown"
  | null;

interface JobLookup {
  state: BullMqStateOrNull;
  failedReason: string | null;
  error: boolean;
}

// Deterministic jobId matches sequencing.ts's `${runId}-${step}` scheme.
// This means the reconciler can look up the exact job for a checkpoint
// row in O(1) via q.getJob(id) — no need to scan all queue states.
async function lookupJob(step: DagStep, runId: string): Promise<JobLookup> {
  try {
    const queue = getQueue(step);
    const job = await queue.getJob(`${runId}-${step}`);
    if (!job) return { state: null, failedReason: null, error: false };
    const state = await job.getState();
    return {
      state: state as BullMqStateOrNull,
      failedReason: job.failedReason ?? null,
      error: false,
    };
  } catch (err) {
    console.warn(`[orchestrator] lookupJob failed for step=${step} run=${runId}, skipping reconciliation:`, err);
    return { state: null, failedReason: null, error: true };
  }
}

// Periodic sweep — installed by startWorkers so a split-brain doesn't
// need a process restart to resolve. Returns the interval handle so
// stopWorkers can clear it during graceful shutdown.
export function startPeriodicReconciliation(intervalMs: number = RECONCILE_INTERVAL_MS): NodeJS.Timeout {
  return setInterval(() => {
    reconcileStuckRunningSteps().catch((err) => {
      console.error("[orchestrator] periodic reconciliation failed:", err);
    });
  }, intervalMs);
}
