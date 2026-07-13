// Worker registry — 12 workers, one per step. Each worker:
//   - executes the handler (with the checkpoint idempotency wrap)
//   - on completed: calls advance(step, data) to enqueue the next
//   - on failed w/ retries exhausted: marks the checkpoint failed_permanent
//
// A single `startWorkers()` call boots the whole set — used by both
// the standalone worker process (workerProcess.ts) and the integration
// test's inline worker startup.

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./redis";
import { DAG_STEPS, type DagStep } from "./steps";
import { queueName, WORKER_CONFIG } from "./queues";
import { handlers, type JobData } from "./handlers";
import { advance } from "./sequencing";
import * as checkpoint from "./checkpoint.repository";

const activeWorkers = new Map<DagStep, Worker>();

export function startWorkers(): Worker[] {
  if (activeWorkers.size > 0) {
    return [...activeWorkers.values()];
  }
  for (const step of DAG_STEPS) {
    const worker = new Worker(
      queueName(step),
      async (job: Job<JobData>) => {
        return await handlers[step](job.data);
      },
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
      await checkpoint.recordAttemptError(job.data.runId, step, err.message);
      if (attemptsMade >= attemptsLimit) {
        await checkpoint.markFailedPermanent(job.data.runId, step, err.message);
        console.error(
          `[orchestrator] step=${step} run=${job.data.runId} FAILED PERMANENT after ${attemptsMade} attempts: ${err.message}`
        );
      } else {
        console.warn(
          `[orchestrator] step=${step} run=${job.data.runId} failed attempt ${attemptsMade}/${attemptsLimit}: ${err.message}`
        );
      }
    });

    activeWorkers.set(step, worker);
  }
  return [...activeWorkers.values()];
}

export async function stopWorkers(): Promise<void> {
  for (const w of activeWorkers.values()) await w.close();
  activeWorkers.clear();
}

export function isWorkerActive(step: DagStep): boolean {
  return activeWorkers.has(step);
}
