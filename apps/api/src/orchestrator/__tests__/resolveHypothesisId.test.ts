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
});
