// One BullMQ Queue per DAG step. Twelve queues (not one shared queue)
// so each stage gets its own concurrency + rate-limit config —
// Validation in particular needs a Tavily-facing limiter that must not
// leak to the LLM-bound steps.
//
// The Queue instances are created lazily (via getQueue) so a process
// that only needs the API layer doesn't spin up a worker connection
// per queue.
import { Queue, FlowProducer, type QueueOptions } from "bullmq";
import { getRedisConnection } from "./redis";
import { DAG_STEPS, type DagStep } from "./steps";

const queues = new Map<DagStep, Queue>();
let flowProducer: FlowProducer | null = null;

// Retry policy shared across all 12 queues: 3 attempts total, exponential
// backoff starting at 5s. Only after the 3rd attempt fails does the
// handler's on-failed hook mark the checkpoint failed_permanent.
export const DEFAULT_JOB_OPTIONS: QueueOptions["defaultJobOptions"] = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { count: 1000 }, // keep the last 1000 for debugging
  removeOnFail: { count: 1000 },
};

export function getQueue(step: DagStep): Queue {
  const existing = queues.get(step);
  if (existing) return existing;
  const q = new Queue(queueName(step), {
    connection: getRedisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queues.set(step, q);
  return q;
}

export function queueName(step: DagStep): string {
  // BullMQ disallows ':' in queue names (reserved for its internal
  // Redis-key prefixes) — use a hyphen separator instead.
  return `dag-${step}`;
}

export function getFlowProducer(): FlowProducer {
  if (flowProducer) return flowProducer;
  flowProducer = new FlowProducer({ connection: getRedisConnection() });
  return flowProducer;
}

export async function closeAll(): Promise<void> {
  for (const q of queues.values()) await q.close();
  queues.clear();
  if (flowProducer) {
    await flowProducer.close();
    flowProducer = null;
  }
}

// Per-step worker concurrency + limiter. Validation's limiter doubles
// as the fix for the previously-flagged "Tavily rate-limit integration"
// follow-up — 5 requests / second is a conservative floor well under
// Tavily's documented ceiling on paid plans and even the free tier.
// The LLM steps get concurrency 1 by default because NIM's Phase 4
// live runs already show head-of-line contention above that at MVP
// hardware; can be tuned upward when the account's quotas widen.
export interface WorkerConcurrencyConfig {
  concurrency: number;
  limiter?: { max: number; duration: number };
}

export const WORKER_CONFIG: Record<DagStep, WorkerConcurrencyConfig> = {
  discovery: { concurrency: 1 },
  expansion: { concurrency: 1 },
  filtering: { concurrency: 2 }, // deterministic, cheap
  competitive_analysis: { concurrency: 1 },
  hypothesis: { concurrency: 1 },
  validation: {
    concurrency: 1,
    // Tavily rate-limit envelope. `max` requests per `duration` ms
    // per queue globally — BullMQ enforces this across workers.
    limiter: { max: 5, duration: 1000 },
  },
  confidence_mode1: { concurrency: 1 },
  composition: { concurrency: 2 }, // deterministic, DB-only
  scoring: { concurrency: 2 }, // deterministic, DB-only
  confidence_mode2: { concurrency: 2 }, // deterministic
  founder_fit: { concurrency: 1 }, // LLM
  compression: { concurrency: 1 }, // holds a $transaction
  opportunity_rationale: { concurrency: 1 }, // LLM (post-terminal polish)
};

export function listQueueNames(): string[] {
  return DAG_STEPS.map(queueName);
}
