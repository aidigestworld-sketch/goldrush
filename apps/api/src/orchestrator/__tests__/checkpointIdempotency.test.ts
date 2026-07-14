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
