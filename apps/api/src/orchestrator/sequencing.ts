// Sequencing: how one step's completion enqueues the next.
//
// LINEAR CHAIN (discovery → ... → scoring): on the `completed` event
// for step N, enqueue step N+1's job with the same run_id / hypothesis_id
// payload. Enqueue only when the checkpoint row for N+1 isn't already
// succeeded (idempotency; also covers the resume case).
//
// FORK/JOIN (scoring → confidence_mode2 + founder_fit → compression):
// on scoring's `completed`, use FlowProducer to add compression as
// PARENT with both branches as CHILDREN. BullMQ enforces that the
// compression job stays waiting-children until both branches complete
// successfully.
//
// The sequencing lives outside the handlers so a single-step retry
// (via the /retry endpoint) still triggers the correct next-step
// enqueue when it succeeds — the retried job goes through the same
// completed event listener.

import { FlowProducer } from "bullmq";
import { getQueue, getFlowProducer } from "./queues";
import {
  LINEAR_ORDER,
  FORK_CHILDREN,
  JOIN_STEP,
  POST_JOIN_STEP,
  nextLinearStep,
  type DagStep,
} from "./steps";
import { queueName } from "./queues";
import * as checkpoint from "./checkpoint.repository";
import { tryResolveOpportunityIdForRun } from "./idResolvers";
import type { JobData } from "./handlers";

// enqueueStep: idempotent by dag_run_state. If the target step's row
// already exists and is 'succeeded', short-circuit — the handler would
// no-op anyway, but a stray "please re-run this" enqueue would create
// noise in agent_execution_log.
export async function enqueueStep(step: DagStep, data: JobData): Promise<{ enqueued: boolean; reason?: string }> {
  const existing = await checkpoint.getRow(data.runId, step);
  if (existing?.status === "succeeded") {
    return { enqueued: false, reason: "already succeeded" };
  }
  // Always upsert-pending so the row exists BEFORE the job is picked up
  // — this prevents a race where the worker reads dag_run_state before
  // the API caller has written a row.
  await checkpoint.upsertPending({
    runId: data.runId,
    step,
    hypothesisId: data.hypothesisId,
    candidateId: data.candidateId ?? null,
  });
  const jobId = `${data.runId}-${step}`;
  const q = getQueue(step);
  // BullMQ dedupes by jobId, and removeOnComplete keeps completed jobs in
  // Redis. Remove any stale job before re-adding so that a checkpoint-reset
  // + re-enqueue actually fires a new job rather than silently no-oping.
  const stale = await q.getJob(jobId);
  if (stale) await stale.remove();
  await q.add(step, data, { jobId });
  return { enqueued: true };
}

// advance: called on a step's `completed` event. Decides what fires next.
// - LINEAR: enqueue the next linear step
// - SCORING (last linear): fan out via FlowProducer to compression + children
// - COMPRESSION: nothing (terminal)
export async function advance(justCompleted: DagStep, data: JobData): Promise<void> {
  // The seam between the linear chain and the fork/join is scoring —
  // scoring is the last member of LINEAR_ORDER, so nextLinearStep(scoring)
  // returns null and we fall into the fork branch.
  if (justCompleted === "scoring") {
    await addForkJoinFlow(data);
    return;
  }
  if (justCompleted === JOIN_STEP) {
    // Compression's underlying agent has already updated pipeline_run.status
    // and the frontend already renders the run as "completed" (see
    // deriveOverallStatus in api.ts, which is unchanged). Kick off
    // OpportunityRationale as a post-terminal polish step that fills
    // opportunity.rationale_bullets / risk_summary — decoupled from the
    // promotion transaction so a failure or slow LLM doesn't hold the
    // user-visible run status.
    const opportunityId = await tryResolveOpportunityIdForRun(data.runId, undefined);
    if (!opportunityId) {
      // Compression promoted nothing (insufficient_evidence terminal).
      // No opportunity row to phrase — skip cleanly, no checkpoint row.
      return;
    }
    await enqueueStep(POST_JOIN_STEP, { ...data, opportunityId });
    return;
  }
  if (justCompleted === POST_JOIN_STEP) {
    // Truly terminal — nothing else to enqueue.
    return;
  }
  const next = nextLinearStep(justCompleted);
  if (next) {
    await enqueueStep(next, data);
  }
}

// addForkJoinFlow: the ONE FlowProducer call in the whole orchestrator.
// Uses BullMQ's parent-with-children construct so compression sits in
// the wait-children state until both cm2 and founderFit succeed.
//
// One subtlety: FlowProducer.add creates the parent + child jobs in a
// single Redis transaction, but our checkpoint rows must exist for the
// three steps too. Write them first, then add the flow.
async function addForkJoinFlow(data: JobData): Promise<void> {
  for (const step of [...FORK_CHILDREN, JOIN_STEP]) {
    await checkpoint.upsertPending({
      runId: data.runId,
      step,
      hypothesisId: data.hypothesisId,
      candidateId: data.candidateId ?? null,
    });
  }
  const producer: FlowProducer = getFlowProducer();
  await producer.add({
    name: JOIN_STEP,
    queueName: queueName(JOIN_STEP),
    data,
    opts: { jobId: `${data.runId}-${JOIN_STEP}` },
    children: FORK_CHILDREN.map((child) => ({
      name: child,
      queueName: queueName(child),
      data,
      opts: { jobId: `${data.runId}-${child}` },
    })),
  });
}

// Resume helper for the /orchestrate endpoint. Finds the earliest
// non-succeeded step and (re-)enqueues from there. If nothing is
// pending/failed, returns null → the API responds "already complete".
export async function resumeFromCheckpoint(data: JobData): Promise<{ resumedFrom: DagStep | null }> {
  const rows = await checkpoint.listForRun(data.runId);
  const byStep = new Map(rows.map((r) => [r.step, r]));

  for (const step of LINEAR_ORDER) {
    const row = byStep.get(step);
    if (!row) {
      // Never enqueued — start from here.
      await enqueueStep(step, data);
      return { resumedFrom: step };
    }
    if (row.status === "succeeded") continue;
    // pending, running, or failed_permanent — (re-)enqueue.
    await enqueueStep(step, data);
    return { resumedFrom: step };
  }

  // Linear chain fully succeeded; check the fork/join.
  const cm2 = byStep.get("confidence_mode2");
  const ff = byStep.get("founder_fit");
  const comp = byStep.get(JOIN_STEP);

  if (
    (!cm2 || cm2.status !== "succeeded") ||
    (!ff || ff.status !== "succeeded")
  ) {
    // Rebuild the fork/join flow if any of the three rows are missing
    // or unfinished.
    await addForkJoinFlow(data);
    return { resumedFrom: "confidence_mode2" };
  }

  if (!comp || comp.status !== "succeeded") {
    // Both branches succeeded but compression not; enqueue it alone.
    await enqueueStep(JOIN_STEP, data);
    return { resumedFrom: JOIN_STEP };
  }

  // Compression succeeded — check the post-join polish step. Only
  // (re-)enqueue if a promoted opportunity actually exists; otherwise
  // there's nothing to phrase and the run is truly done.
  const rationale = byStep.get(POST_JOIN_STEP);
  if (rationale?.status === "succeeded") return { resumedFrom: null };
  const opportunityId = await tryResolveOpportunityIdForRun(data.runId, undefined);
  if (!opportunityId) return { resumedFrom: null };
  await enqueueStep(POST_JOIN_STEP, { ...data, opportunityId });
  return { resumedFrom: POST_JOIN_STEP };
}
