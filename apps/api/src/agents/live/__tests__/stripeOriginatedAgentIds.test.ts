// Regression tests for the "prisma.X.findUnique({ where: { id: undefined } })"
// bug class in orchestrator-called agents. Each test invokes an agent
// with `undefined` for its resolvable id (mirroring what BullMQ hands
// back on a Stripe-originated run whose JobData was serialized without
// hypothesisId/problemId/candidateId) and asserts the agent DOES NOT
// throw Prisma's "Invalid prisma.X.findUnique() invocation" error.
//
// The specific incident that motivated this sweep: Composition hit the
// Prisma error at the direct `prisma.hypothesis.findUnique({ where: { id:
// hypothesisId } })` inside compositionAgent.ts even though the handler
// was already routing through resolveHypothesisIdForRun. The fix
// pushes resolution INTO each agent (defense-in-depth) so the guarantee
// no longer depends on a well-behaved caller.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runCompositionAgent } from "../compositionAgent";
import { runHypothesisAgent } from "../hypothesisAgent";
import { runCompetitiveAnalysisAgent } from "../competitiveAnalysisAgent";
import { runScoringAgent } from "../scoringAgent";
import { runConfidenceMode2Agent } from "../confidenceMode2Agent";
import { runFounderFitAgent } from "../founderFitAgent";
import { prisma } from "../../../db/client";
import type { LLMClient } from "../../../sandbox/llmClient";

// Stable UUIDs isolated from real data.
const RUN_ID = "f867b348-2222-4000-a000-000000000020";
const EMPTY_RUN_ID = "f867b348-2222-4000-a000-000000000099";
const AUTH_USER_ID = "f867b348-2222-4000-a000-000000000021";
let founderId: string;

// Trivial mock LLM (never actually invoked in these tests — the agents
// skip long before any LLM call).
const noopLlm: LLMClient = {
  generate: async () => ({ text: "", raw: {} }),
} as unknown as LLMClient;

describe("Stripe-originated agent-id resolution — no Prisma findUnique-with-undefined error", () => {
  beforeAll(async () => {
    await prisma.opportunityCandidate.deleteMany({ where: { runId: RUN_ID } });
    await prisma.hypothesis.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.problem.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });

    const founder = await prisma.founder.create({
      data: { authUserId: AUTH_USER_ID, expertise: [], industries: [], constraints: [] },
    });
    founderId = founder.id;
    await prisma.pipelineRun.create({
      data: { runId: RUN_ID, founderId, vertical: "shopify_subscriptions" },
    });

    await prisma.problem.create({
      data: {
        label: "test-problem",
        problemMaturity: "recognized_unsolved",
        status: "active",
        pipelineRunId: RUN_ID,
      },
    });
    // Hypothesis below the gate so composition/confidence skip cleanly
    // without needing the full sandbox pipeline set up.
    await prisma.hypothesis.create({
      data: {
        statement: "Test hypothesis (below gate)",
        gapType: "positioning",
        missingData: [],
        status: "active",
        pipelineRunId: RUN_ID,
        validationScore: 0.1,
      },
    });
    await prisma.opportunityCandidate.create({
      data: { runId: RUN_ID, status: "candidate" },
    });
  });

  afterAll(async () => {
    await prisma.opportunityCandidate.deleteMany({ where: { runId: RUN_ID } });
    await prisma.hypothesis.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.problem.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    await prisma.$disconnect();
  });

  // Helper: run a callback and assert the returned promise did not
  // reject with a Prisma "invalid findUnique invocation" error.
  async function assertNoInvalidFindUnique<T>(exec: () => Promise<T>): Promise<T | undefined> {
    try {
      return await exec();
    } catch (err) {
      const msg = (err as Error).message;
      // If Prisma's undefined-id guard was tripped, this substring appears.
      expect(msg).not.toMatch(/Invalid prisma\..*findUnique.*invocation/i);
      // The only legitimate throw path is our "no X found" resolver
      // error, which is what the handler-idempotency layer catches.
      // Anything else re-throw so the test still fails visibly.
      if (!/no active hypothesis found|no active problem found|no candidate found/.test(msg)) {
        throw err;
      }
    }
  }

  it("runCompositionAgent(runId, undefined) — self-resolves the hypothesis for a Stripe-originated run", async () => {
    const result = await assertNoInvalidFindUnique(() => runCompositionAgent(RUN_ID, undefined));
    expect(result).toBeDefined();
    expect(result!.skipped).toBe(true);
    // Below-gate skip means the resolver worked and the agent then
    // rejected based on validationScore < 0.5 — not a findUnique crash.
    expect(result!.skipReason).toMatch(/below gate|not yet scored/);
  });

  it("runHypothesisAgent(runId, undefined, llm) — self-resolves the problem", async () => {
    const result = await assertNoInvalidFindUnique(() =>
      runHypothesisAgent(RUN_ID, undefined, noopLlm)
    );
    expect(result).toBeDefined();
    // Either skipped (no existing_solutions edges — expected for this
    // minimal setup) or succeeded; both are fine as long as no Prisma
    // findUnique-with-undefined crash occurred.
    expect(result!.skipped).toBe(true);
  });

  it("runCompetitiveAnalysisAgent(runId, undefined, ...) — self-resolves the problem", async () => {
    const result = await assertNoInvalidFindUnique(() =>
      runCompetitiveAnalysisAgent(RUN_ID, undefined, new Map(), noopLlm)
    );
    expect(result).toBeDefined();
    expect(result!.skipped).toBe(true);
  });

  it("runScoringAgent(runId, undefined, vertical) — self-resolves the candidate", async () => {
    const result = await assertNoInvalidFindUnique(() =>
      runScoringAgent(RUN_ID, undefined, "b2b_customer_support")
    );
    expect(result).toBeDefined();
    expect(result!.skipped).toBe(true);
  });

  it("runConfidenceMode2Agent(runId, undefined) — self-resolves the candidate", async () => {
    const result = await assertNoInvalidFindUnique(() =>
      runConfidenceMode2Agent(RUN_ID, undefined)
    );
    expect(result).toBeDefined();
    expect(result!.skipped).toBe(true);
  });

  it("runFounderFitAgent(runId, undefined, founderId, llm) — self-resolves the candidate", async () => {
    const result = await assertNoInvalidFindUnique(() =>
      runFounderFitAgent(RUN_ID, undefined, founderId, noopLlm)
    );
    expect(result).toBeDefined();
    expect(result!.skipped).toBe(true);
  });

  it("runCompositionAgent(EMPTY_RUN_ID, undefined) — SKIPS cleanly instead of throwing", async () => {
    // Post-skip-cascade-fix (see upstreamSkipCascade.test.ts): agents no
    // longer throw when their upstream produced no row — they return
    // a skipReason. This lets a fresh run whose Discovery produced zero
    // markets (bug ba923046) complete with clean partial state instead
    // of flipping pipeline_run.status to 'failed'. Confirms the agent
    // does NOT hit Prisma with an undefined id (original bug class)
    // AND does NOT throw the resolver's error.
    const result = await runCompositionAgent(EMPTY_RUN_ID, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("no active hypothesis");
    expect(result.candidateId).toBeNull();
  });
});
