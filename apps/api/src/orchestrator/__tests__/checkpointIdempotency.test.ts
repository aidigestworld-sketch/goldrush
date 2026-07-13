import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { handlers } from "../handlers";
import * as checkpoint from "../checkpoint.repository";
import { prisma } from "../../db/client";

const RUN_ID_SEED = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";
const TAG = "test-orch-idem-";
const step = "filtering" as const;

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
