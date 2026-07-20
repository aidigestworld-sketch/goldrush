// Worker registry — one worker per DAG step (see DAG_STEPS). Each worker:
//   - executes the handler (with the checkpoint idempotency wrap)
//   - on completed: calls advance(step, data) to enqueue the next
//   - on failed w/ retries exhausted: marks the checkpoint failed_permanent
//
// A single `startWorkers()` call boots the whole set — used by both
// the standalone worker process (workerProcess.ts) and the integration
// test's inline worker startup.

import { Worker, UnrecoverableError, type Job, type MinimalJob } from "bullmq";
import { getRedisConnection } from "./redis";
import { DAG_STEPS, type DagStep } from "./steps";
import { queueName, WORKER_CONFIG } from "./queues";
import { handlers, type JobData } from "./handlers";
import { advance } from "./sequencing";
import * as checkpoint from "./checkpoint.repository";
import { formatErrorForStorage, isNimGatewayTimeout } from "./errorFormatting";
import { reconcileStuckRunningSteps, startPeriodicReconciliation } from "./reconciliation";

const activeWorkers = new Map<DagStep, Worker>();
let reconcileInterval: NodeJS.Timeout | null = null;

// Exported for unit testing. Wraps a handler so that specific error
// classes get promoted to BullMQ's UnrecoverableError (which skips
// remaining retries) instead of the default retry-until-exhausted
// behavior. Only NIM gateway 504 qualifies right now — see
// isNimGatewayTimeout for the rationale. Other error types
// (network hiccups, JSON parse failures, timeouts we control) pass
// through unchanged and keep the normal 3-attempt retry budget.
//
// NIM 504 policy: allow exactly ONE retry, then fail permanent.
//   - The original fail-fast-on-first-504 policy assumed retrying would
//     "hammer an already-struggling gateway."
//   - runDiscoveryReproTest.ts empirically disproved that: 3 sequential
//     Discovery-sized calls direct to NIM (100k-token prompt against
//     nvidia-nemotron-nano-9b-v2) went OK@163s → 504@302s → 504@302s.
//     Each attempt is an independent draw against NIM's ~300s gateway
//     timeout, not a correlated overload state. One retry has ~75%
//     cumulative success chance for prompts sitting near the token
//     ceiling.
//   - `job.attemptsMade` inside a BullMQ processor is 0-indexed count
//     of PREVIOUS attempts (0 on first execution, 1 on first retry).
//     Wrapping only when attemptsMade >= 1 lets BullMQ retry the first
//     504 once, then stops on the second.
//   - The queue's 5s exponential backoff (queues.ts:22) gives the retry
//     a natural cool-down window — no separate delay logic needed.
export function makeFailFastHandler<T>(
  handler: () => Promise<T>,
  job: MinimalJob | null
): Promise<T> {
  return handler().catch((err: unknown) => {
    if (isNimGatewayTimeout(err) && (job?.attemptsMade ?? 0) >= 1) {
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new UnrecoverableError(message);
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
    throw err;
  });
}

// Exported for unit testing. Encapsulates the branching that decides
// whether a given failure should mark the checkpoint failed_permanent
// on THIS attempt (rather than waiting for BullMQ to exhaust the
// retry budget on subsequent attempts). Three paths lead to permanent:
//   1. attemptsMade has reached attemptsLimit (normal exhaustion)
//   2. The error is an UnrecoverableError (BullMQ won't retry these)
//   3. A RAW NIM 504 arrives at attemptsMade >= 2 — defense-in-depth
//      for the one-retry-on-504 policy in case a 504 leaks past
//      makeFailFastHandler (e.g., a 504 raised outside its scope).
// A raw NIM 504 at attemptsMade === 1 is intentionally NOT permanent;
// makeFailFastHandler will re-wrap the next one if it recurs.
export function evaluateWorkerFailure(opts: {
  attemptsMade: number;
  attemptsLimit: number;
  err: unknown;
}): { markPermanent: boolean; failFast: boolean } {
  const isUnrecoverable = opts.err instanceof UnrecoverableError;
  const isRaw504 = !isUnrecoverable && isNimGatewayTimeout(opts.err);
  if (isRaw504) {
    // First raw 504: let BullMQ retry (natural 5s exponential backoff).
    // Second consecutive raw 504: cap here.
    const markPermanent = opts.attemptsMade >= 2;
    return { markPermanent, failFast: markPermanent };
  }
  const failFast = isUnrecoverable;
  const markPermanent = opts.attemptsMade >= opts.attemptsLimit || failFast;
  return { markPermanent, failFast };
}

export function startWorkers(): Worker[] {
  if (activeWorkers.size > 0) {
    return [...activeWorkers.values()];
  }
  // Startup reconciliation: any dag_run_state row where BullMQ has
  // moved past the row's state (row 'pending'/'running' but BullMQ
  // 'failed'/'completed') gets mirrored to the BullMQ terminal state.
  // Also catches 'running' rows past STALE_THRESHOLD_MS with no BullMQ
  // job (the "worker died mid-attempt" case). Fire-and-forget so
  // startup doesn't block on the DB sweep.
  reconcileStuckRunningSteps().catch((err) => {
    console.error("[orchestrator] startup reconciliation failed:", err);
  });

  // Periodic reconciliation: same sweep on a 2-min timer. Catches the
  // split-brain WITHOUT requiring a process restart — the case where
  // on('failed')'s recordAttemptError commits but markFailedPermanent
  // gets killed mid-await (worker.on-failed handler below is not
  // transactional between those two calls).
  reconcileInterval = startPeriodicReconciliation();

  for (const step of DAG_STEPS) {
    const worker = new Worker(
      queueName(step),
      (job: Job<JobData>) => makeFailFastHandler(() => handlers[step](job.data), job),
      {
        connection: getRedisConnection(),
        concurrency: WORKER_CONFIG[step].concurrency,
        limiter: WORKER_CONFIG[step].limiter,
      }
    );

    worker.on("completed", async (job, result) => {
      try {
        await advance(step, job.data as JobData);
      } catch (err) {
        // A failure inside advance shouldn't fail the just-completed
        // step — that step DID succeed. Log it so an operator can
        // manually re-invoke the next step via the /retry endpoint or
        // by re-calling /orchestrate (idempotent).
        console.error(`[orchestrator] advance failed after step=${step} run=${job.data.runId}:`, err);
      }
    });

    worker.on("failed", async (job, err) => {
      if (!job) return;
      const attemptsMade = job.attemptsMade;
      const attemptsLimit = job.opts.attempts ?? 1;
      // Serialize the full .cause chain — err.message alone drops the
      // underlying network/DNS/TLS code (ECONNREFUSED etc.) that undici
      // hides beneath its generic "fetch failed" wrapper.
      const errorForStorage = formatErrorForStorage(err);
      await checkpoint.recordAttemptError(job.data.runId, step, errorForStorage);
      const { markPermanent, failFast } = evaluateWorkerFailure({
        attemptsMade,
        attemptsLimit,
        err,
      });
      if (markPermanent) {
        await checkpoint.markFailedPermanent(job.data.runId, step, errorForStorage);
        console.error(
          `[orchestrator] step=${step} run=${job.data.runId} FAILED PERMANENT ` +
            (failFast
              ? `on attempt ${attemptsMade} (NIM gateway 504 — one retry already attempted, still 504)`
              : `after ${attemptsMade} attempts`) +
            `:\n${errorForStorage}`
        );
      } else {
        console.warn(
          `[orchestrator] step=${step} run=${job.data.runId} failed attempt ${attemptsMade}/${attemptsLimit}:\n${errorForStorage}`
        );
      }
    });

    // BullMQ fires 'stalled' when a job's lock expires — the worker was
    // holding it but never released or renewed (crashed process, OS kill,
    // stop-the-world GC). BullMQ then requeues the job automatically up
    // to `maxStalledCount`, but our dag_run_state row is left at
    // status='running' with no visible indication of what happened.
    // Record it against the checkpoint so the next attempt overwrites
    // rather than silently piling on top of a stale error.
    worker.on("stalled", async (jobId, prev) => {
      console.warn(`[orchestrator] step=${step} jobId=${jobId} stalled (prev=${prev}) — BullMQ will re-enqueue`);
    });

    activeWorkers.set(step, worker);
  }
  return [...activeWorkers.values()];
}

export async function stopWorkers(): Promise<void> {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
  }
  for (const w of activeWorkers.values()) await w.close();
  activeWorkers.clear();
}

export function isWorkerActive(step: DagStep): boolean {
  return activeWorkers.has(step);
}
