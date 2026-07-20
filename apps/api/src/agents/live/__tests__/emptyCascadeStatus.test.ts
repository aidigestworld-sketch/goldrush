// End-to-end trace for a pipeline where Discovery produces zero markets
// and everything downstream skips cleanly (the ba923046 case).
//
// Verifies the invariant a paying founder depends on: the run's final
// pipeline_run.status MUST end at 'insufficient_evidence', NOT
// 'completed'. A "completed" status with zero rationale/opportunity
// would look like a normal success in the UI — a much worse experience
// than an honest "we couldn't find enough signal" flag.
//
// The chain being pinned:
//   Discovery      → skipped (0 markets)          → succeeded
//   Expansion      → skipped (handler no-marketId) → succeeded
//   CA / Hypothesis → skipped                     → succeeded
//   Validation / Confidence / Composition → skipped cleanly (post-fix)
//   Scoring / CM2 / FF                    → skipped (no candidate)
//   Compression → 0 candidates → terminalCommit → status='insufficient_evidence' ✓
//
// This test drives Compression directly with the same DB state the
// cascade would leave behind (a run row, no markets, no problems, no
// hypotheses, no candidates). Compression is the ONLY component that
// touches pipeline_run.status in the terminal-write path, so proving
// its behaviour here is sufficient.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../db/client";
import { runCompressionAgent } from "../compressionAgent";
import { deriveOverallStatus } from "../../../orchestrator/api";
import { DAG_STEPS } from "../../../orchestrator/steps";

const RUN_ID = "f867b348-5555-4000-a000-000000000050";
const AUTH_USER_ID = "f867b348-5555-4000-a000-000000000051";

describe("Empty-cascade run → Compression sets pipeline_run.status='insufficient_evidence'", () => {
  let founderId: string;

  beforeAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
    await prisma.opportunityCandidate.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });

    const founder = await prisma.founder.create({
      data: { authUserId: AUTH_USER_ID, expertise: [], industries: [], constraints: [] },
    });
    founderId = founder.id;
    await prisma.pipelineRun.create({
      data: { runId: RUN_ID, founderId, vertical: "shopify_subscriptions", status: "running" },
    });
    // DO NOT seed any markets / problems / hypotheses / candidates —
    // this is the ba923046 state exactly.
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
    await prisma.opportunityCandidate.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    await prisma.$disconnect();
  });

  it("runCompressionAgent with zero candidates → terminalCommit sets status='insufficient_evidence'", async () => {
    const result = await runCompressionAgent(RUN_ID);
    expect(result.notReady).toBe(false);
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.winnerId).toBeNull();
    expect(result.createdOpportunityId).toBeNull();
    expect(result.trace?.[0]).toContain("no candidates");

    // The invariant the founder-facing UI depends on: a completed run
    // with zero content is NOT status='completed'.
    const run = await prisma.pipelineRun.findUnique({ where: { runId: RUN_ID } });
    expect(run?.status).toBe("insufficient_evidence");
    expect(run?.status).not.toBe("completed");
    expect(run?.currentStage).toBe("completed");
    expect(run?.completedAt).not.toBeNull();
  });

  it("no Opportunity row is created for an empty-cascade run", async () => {
    // Guard against the frontend rendering a phantom-empty opportunity.
    const opps = await prisma.opportunity.findMany({
      where: { promotedFromCandidate: { runId: RUN_ID } },
    });
    expect(opps).toEqual([]);
  });

  // End-to-end regression for the 2026-07-20 report where a b2b_customer_
  // _support_saas run rendered as a green "Completed" badge with 9-12ms
  // per-step durations. Every step DID succeed (short-circuit through
  // empty-evidence skip guards) so the dag_run_state-only derivation
  // returned "completed" — hiding the fact that pipeline_run.status was
  // "insufficient_evidence". This test pins the fix: the derivation MUST
  // consult pipelineRunStatus and surface the distinct terminal state.
  it("deriveOverallStatus with the post-cascade state returns 'insufficient_evidence', not 'completed'", async () => {
    const pipelineRun = await prisma.pipelineRun.findUnique({ where: { runId: RUN_ID } });
    expect(pipelineRun?.status).toBe("insufficient_evidence");

    // The cascade leaves every dag_run_state row succeeded (skip-clean
    // path — see emptyCascadeStatus header). Simulate that shape:
    const allSucceeded = DAG_STEPS.map((step) => ({ step, status: "succeeded" }));

    // Without the pipelineRunStatus signal, the join-succeeded branch
    // wins and this would be "completed" — the bug the founder saw.
    expect(deriveOverallStatus(allSucceeded)).toBe("completed");

    // WITH the signal, the derivation surfaces the honest outcome.
    expect(deriveOverallStatus(allSucceeded, pipelineRun?.status)).toBe(
      "insufficient_evidence"
    );
  });
});
