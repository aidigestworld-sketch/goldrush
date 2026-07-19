import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handlers } from "../handlers";
import * as checkpoint from "../checkpoint.repository";
import { prisma } from "../../db/client";

const RUN_ID_SEED = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";
const TAG = "test-orch-idem-";
const step = "filtering" as const;

// Stable UUIDs for the markFailedPermanent atomicity test.
const RUN_ID_FAIL = "f867b348-0000-4000-a000-000000000088";
const AUTH_USER_FAIL = "ffffffff-0000-4000-a000-000000000088";
const FAIL_STEP = "discovery" as const;

// Stable UUID for the missing-row / phantom job test. Chosen to not
// collide with any other seeded runId in the suite.
const RUN_ID_PHANTOM = "abc12345-0000-4000-a000-000000000099";
const PHANTOM_STEP = "filtering" as const;

describe("checkpointIdempotency", () => {
  beforeAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID_SEED, step } });
    await checkpoint.upsertPending({ runId: RUN_ID_SEED, step, hypothesisId: null, candidateId: null });
    await checkpoint.markRunning(RUN_ID_SEED, step);
    await checkpoint.markSucceeded(RUN_ID_SEED, step, null);
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID_SEED, step } });
    await prisma.$disconnect();
  });

  it("arrange: row is status=succeeded", async () => {
    const before = await checkpoint.getRow(RUN_ID_SEED, step);
    expect(before?.status).toBe("succeeded");
  });

  it("first re-invocation: skipped=true, skipReason mentions already succeeded, row and attempt_count untouched", async () => {
    const before = await checkpoint.getRow(RUN_ID_SEED, step);
    const attemptCountBefore = before?.attemptCount ?? -1;

    const result = await handlers.filtering({ runId: RUN_ID_SEED, hypothesisId: TAG + "unused" });
    expect(result.skipped).toBe(true);
    expect(typeof result.skipReason === "string" && result.skipReason.includes("already succeeded")).toBe(true);

    const after = await checkpoint.getRow(RUN_ID_SEED, step);
    expect(after?.status).toBe("succeeded");
    expect(after?.attemptCount).toBe(attemptCountBefore);
  });

  it("second re-invocation also returns skipped=true", async () => {
    const result2 = await handlers.filtering({ runId: RUN_ID_SEED, hypothesisId: TAG + "unused" });
    expect(result2.skipped).toBe(true);
  });
});

describe("markFailedPermanent atomicity", () => {
  let failFounderId: string;

  beforeAll(async () => {
    const founder = await prisma.founder.create({
      data: { authUserId: AUTH_USER_FAIL, expertise: [], industries: [], constraints: [] },
    });
    failFounderId = founder.id;
    await prisma.pipelineRun.create({
      data: { runId: RUN_ID_FAIL, founderId: failFounderId, vertical: "shopify_subscriptions" },
    });
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID_FAIL } });
    await checkpoint.upsertPending({ runId: RUN_ID_FAIL, step: FAIL_STEP });
    await checkpoint.markRunning(RUN_ID_FAIL, FAIL_STEP);
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID_FAIL } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID_FAIL } });
    await prisma.founder.deleteMany({ where: { id: failFounderId } });
    await prisma.$disconnect();
  });

  it("sets dag_run_state.status=failed_permanent AND pipeline_run.status=failed in one transaction", async () => {
    const row = await checkpoint.markFailedPermanent(RUN_ID_FAIL, FAIL_STEP, "simulated exhausted retries");

    expect(row?.status).toBe("failed_permanent");
    expect(row?.lastError).toBe("simulated exhausted retries");

    const run = await prisma.pipelineRun.findUnique({ where: { runId: RUN_ID_FAIL } });
    expect(run?.status).toBe("failed");
  });

  it("returns null when no dag_run_state row exists (pipeline_run.status left unchanged)", async () => {
    const unknownRunId = "f867b348-0000-4000-a000-000000000000";
    const result = await checkpoint.markFailedPermanent(unknownRunId, FAIL_STEP, "no row");
    expect(result).toBeNull();
  });
});

// Regression test for the 2026-07-18 hit-rate study's dominant blocker:
// stale BullMQ jobs left in Redis (from prior test/debug sessions whose
// dag_run_state rows had been cleaned up) got resurrected by workers and
// crashed on P2025 inside markRunning's non-defensive `update()`. Each
// phantom burned 3 retries × ~5 min = 15 min of NIM wall time and marked
// downstream steps stuck.
//
// The fix has two layers:
//   1. markRunning switched from `update()` to `updateMany()` and now
//      returns null when no row matches (matches the defensive pattern
//      already in recordAttemptError and markFailedPermanent).
//   2. withIdempotency null-checks the row before doing ANY work — no
//      agent call, no NIM call, no DB writes. Job ends "completed" from
//      BullMQ's perspective with a skipped=true result.
describe("phantom job / missing dag_run_state row is handled gracefully (no P2025)", () => {
  beforeAll(async () => {
    // Ensure no dag_run_state row exists for RUN_ID_PHANTOM — this is
    // the whole point of the test.
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID_PHANTOM } });
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID_PHANTOM } });
  });

  it("markRunning returns null instead of throwing P2025 when no row exists", async () => {
    const result = await checkpoint.markRunning(RUN_ID_PHANTOM, PHANTOM_STEP);
    expect(result).toBeNull();
  });

  it("handler skips cleanly (skipped=true) instead of crashing when no row exists — filtering step", async () => {
    // Filtering is deterministic and cheap, but importantly under the
    // fix it should never REACH the agent because withIdempotency
    // short-circuits before the run() callback fires.
    const result = await handlers.filtering({ runId: RUN_ID_PHANTOM, hypothesisId: TAG + "phantom" });
    expect(result.skipped).toBe(true);
    expect(typeof result.skipReason === "string" && result.skipReason.includes("no dag_run_state row")).toBe(true);
    // Row must remain non-existent — the fix must NOT accidentally
    // create a row via markRunning as a side effect.
    const row = await checkpoint.getRow(RUN_ID_PHANTOM, PHANTOM_STEP);
    expect(row).toBeNull();
  });

  it("handler skips cleanly regardless of which step — validation is the step P4 was stuck on in the study", async () => {
    // Validation is the concrete step where the P2025 originally
    // surfaced in production during the hit-rate study rerun.
    const result = await handlers.validation({ runId: RUN_ID_PHANTOM, hypothesisId: TAG + "phantom-v" });
    expect(result.skipped).toBe(true);
    expect(typeof result.skipReason === "string" && result.skipReason.includes("no dag_run_state row")).toBe(true);
  });

  it("second call remains idempotent — still skipped, still no row created", async () => {
    // A phantom job that BullMQ retries (before we fixed the retry
    // policy, or if it's a non-504 error path) should hit the same
    // skip on each attempt without accumulating side effects.
    const first = await handlers.filtering({ runId: RUN_ID_PHANTOM, hypothesisId: TAG + "phantom-2" });
    const second = await handlers.filtering({ runId: RUN_ID_PHANTOM, hypothesisId: TAG + "phantom-2" });
    expect(first.skipped).toBe(true);
    expect(second.skipped).toBe(true);
    const row = await checkpoint.getRow(RUN_ID_PHANTOM, PHANTOM_STEP);
    expect(row).toBeNull();
  });
});
