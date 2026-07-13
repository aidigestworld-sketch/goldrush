// Checkpoint repository — the only allowed interface to dag_run_state.
//
// Every handler and API endpoint goes through this file so the
// idempotency contract (never re-run a succeeded step) has ONE
// enforcement point rather than being scattered across 12 handlers.
//
// State machine:
//   pending -> running -> succeeded
//   pending -> running -> pending  (BullMQ retry — attempt_count++)
//   pending -> running -> failed_permanent (attempts exhausted)
//   failed_permanent -> pending   (manual retry via API)
import { prisma } from "../db/client";
import { DAG_STEPS, type DagStep } from "./steps";

export type CheckpointStatus = "pending" | "running" | "succeeded" | "failed_permanent";

export interface CheckpointRow {
  id: string;
  runId: string;
  hypothesisId: string | null;
  candidateId: string | null;
  step: DagStep;
  status: CheckpointStatus;
  attemptCount: number;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

// upsert: idempotent by (run_id, step). Used by the API's orchestrate
// endpoint to (re-)create a row for a step before enqueueing its job.
export async function upsertPending(input: {
  runId: string;
  step: DagStep;
  hypothesisId?: string | null;
  candidateId?: string | null;
}): Promise<CheckpointRow> {
  const row = await prisma.dagRunState.upsert({
    where: { runId_step: { runId: input.runId, step: input.step } },
    update: {
      // Only reset to pending if not already succeeded. This is the
      // "resume from checkpoint" invariant — a re-invocation of
      // orchestrate must never blow away a succeeded step's audit trail.
      // The actual protection lives at the handler layer (returns early
      // on succeeded); this update just refreshes fields.
      hypothesisId: input.hypothesisId ?? undefined,
      candidateId: input.candidateId ?? undefined,
      updatedAt: new Date(),
    },
    create: {
      runId: input.runId,
      step: input.step,
      hypothesisId: input.hypothesisId ?? null,
      candidateId: input.candidateId ?? null,
      status: "pending",
      attemptCount: 0,
    },
  });
  return toDomain(row);
}

export async function getRow(runId: string, step: DagStep): Promise<CheckpointRow | null> {
  const row = await prisma.dagRunState.findUnique({
    where: { runId_step: { runId, step } },
  });
  return row ? toDomain(row) : null;
}

export async function listForRun(runId: string): Promise<CheckpointRow[]> {
  const rows = await prisma.dagRunState.findMany({ where: { runId } });
  return rows
    .map(toDomain)
    .sort((a, b) => DAG_STEPS.indexOf(a.step) - DAG_STEPS.indexOf(b.step));
}

// markRunning: called by handler at job start. Increments attempt_count
// atomically so BullMQ retries produce a visible trail. Returns the
// updated row so the caller can log.
export async function markRunning(runId: string, step: DagStep): Promise<CheckpointRow> {
  const row = await prisma.dagRunState.update({
    where: { runId_step: { runId, step } },
    data: {
      status: "running",
      attemptCount: { increment: 1 },
      startedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return toDomain(row);
}

export async function markSucceeded(
  runId: string,
  step: DagStep,
  candidateId?: string | null
): Promise<CheckpointRow> {
  const row = await prisma.dagRunState.update({
    where: { runId_step: { runId, step } },
    data: {
      status: "succeeded",
      completedAt: new Date(),
      updatedAt: new Date(),
      candidateId: candidateId ?? undefined,
      lastError: null,
    },
  });
  return toDomain(row);
}

// markFailedPermanent: called ONLY by BullMQ's on-failed handler when
// the retry attempts have been exhausted (job.attemptsMade >= attempts).
// Intermediate failures leave the row status='running' (or the DB
// update rolled back if the handler threw before markSucceeded).
export async function markFailedPermanent(
  runId: string,
  step: DagStep,
  errorMessage: string
): Promise<CheckpointRow | null> {
  const affected = await prisma.dagRunState.updateMany({
    where: { runId, step },
    data: {
      status: "failed_permanent",
      lastError: errorMessage.slice(0, 8000),
      updatedAt: new Date(),
    },
  });
  if (affected.count === 0) return null;
  const row = await prisma.dagRunState.findUnique({
    where: { runId_step: { runId, step } },
  });
  return row ? toDomain(row) : null;
}

// Intermediate-failure recording: BullMQ will retry, but we still want
// the last error visible on the checkpoint row so the /status endpoint
// shows something useful. Called on every failure regardless of retry
// disposition — markFailedPermanent then overwrites once retries exhaust.
export async function recordAttemptError(
  runId: string,
  step: DagStep,
  errorMessage: string
): Promise<void> {
  // updateMany rather than update: a stale BullMQ job whose dag_run_state
  // row was manually cleaned up must not crash the worker on its
  // failure callback.
  await prisma.dagRunState.updateMany({
    where: { runId, step },
    data: {
      status: "pending",
      lastError: errorMessage.slice(0, 8000),
      updatedAt: new Date(),
    },
  });
}

// Manual-retry helper for the retry endpoint. Only failed_permanent
// rows may be reset; the API caller is expected to guard for that too,
// but a defense-in-depth check here catches a stale state race.
export async function resetForRetry(runId: string, step: DagStep): Promise<CheckpointRow> {
  const current = await getRow(runId, step);
  if (!current) throw new Error(`no dag_run_state row for run=${runId} step=${step}`);
  if (current.status !== "failed_permanent") {
    throw new Error(
      `cannot retry step=${step} run=${runId}: status is '${current.status}', only failed_permanent is retryable`
    );
  }
  const row = await prisma.dagRunState.update({
    where: { runId_step: { runId, step } },
    data: {
      status: "pending",
      lastError: null,
      updatedAt: new Date(),
    },
  });
  return toDomain(row);
}

function toDomain(row: {
  id: string;
  runId: string;
  hypothesisId: string | null;
  candidateId: string | null;
  step: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}): CheckpointRow {
  return {
    id: row.id,
    runId: row.runId,
    hypothesisId: row.hypothesisId,
    candidateId: row.candidateId,
    step: row.step as DagStep,
    status: row.status as CheckpointStatus,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}
