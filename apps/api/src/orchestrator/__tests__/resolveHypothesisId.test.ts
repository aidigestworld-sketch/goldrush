import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveHypothesisIdForRun } from "../handlers";
import { prisma } from "../../db/client";

// A stable UUID that won't collide with real run data.
const RUN_ID = "f867b348-0000-4000-a000-000000000001";

describe("resolveHypothesisIdForRun", () => {
  let hypothesisId: string;

  beforeAll(async () => {
    await prisma.hypothesis.deleteMany({ where: { pipelineRunId: RUN_ID } });
    const row = await prisma.hypothesis.create({
      data: {
        statement: "Test hypothesis for resolveHypothesisIdForRun",
        gapType: "positioning",
        missingData: [],
        status: "active",
        pipelineRunId: RUN_ID,
      },
    });
    hypothesisId = row.id;
  });

  afterAll(async () => {
    await prisma.hypothesis.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.$disconnect();
  });

  it("undefined trackingKey (Stripe-originated run): resolves via fallback, returns the active hypothesis id", async () => {
    // This is the case that was failing: Stripe runs have no pre-existing
    // hypothesisId, so data.hypothesisId is undefined. Previously this
    // caused Prisma to throw on findUnique({ where: { id: undefined } }).
    const resolved = await resolveHypothesisIdForRun(RUN_ID, undefined);
    expect(resolved).toBe(hypothesisId);
  });

  it("matching trackingKey: resolves via direct findUnique, returns same id", async () => {
    const resolved = await resolveHypothesisIdForRun(RUN_ID, hypothesisId);
    expect(resolved).toBe(hypothesisId);
  });

  it("stale/unknown trackingKey: falls back to most-recent active hypothesis for the run", async () => {
    const staleId = "00000000-0000-0000-0000-000000000000";
    const resolved = await resolveHypothesisIdForRun(RUN_ID, staleId);
    expect(resolved).toBe(hypothesisId);
  });

  it("no hypothesis exists for run: throws with a clear message", async () => {
    const unknownRunId = "f867b348-0000-4000-a000-000000000099";
    await expect(resolveHypothesisIdForRun(unknownRunId, undefined)).rejects.toThrow(
      "no active hypothesis found"
    );
  });

  it("Stripe-originated run (no hypothesisId): resolves via pipelineRunId fallback after Hypothesis Generation writes the row", async () => {
    // Regression guard for the bug that failed the live run at 07:45 on 2026-07-14:
    // The old code passed id: undefined directly to findUnique. The fix skips
    // findUnique when trackingKey is undefined and goes straight to the fallback
    // which queries by pipelineRunId — matching how hypothesisAgent.ts always
    // writes the row (pipelineRunId: runId, line 124).
    //
    // The hypothesis seeded in beforeAll has pipelineRunId: RUN_ID, exactly
    // mirroring what hypothesisAgent.ts produces. Calling with undefined
    // trackingKey must succeed and return the same id.
    const resolved = await resolveHypothesisIdForRun(RUN_ID, undefined);
    expect(resolved).toBe(hypothesisId);
    // Confirm it did NOT throw "Invalid prisma.hypothesis.findUnique() invocation"
    // (the Prisma error seen in dag_run_state.last_error for that live run).
  });
});
