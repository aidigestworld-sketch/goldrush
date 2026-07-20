// Regression for the DAG skip-cascade bug that failed run
// ba923046-... on 2026-07-15: Discovery succeeded with zero markets;
// Expansion / CompetitiveAnalysis / Hypothesis then all early-returned
// via their handler-level guards (no market → skip → no problem → skip
// → no problem → skip); Validation was then enqueued anyway and threw
// "no active hypothesis found for runId=..." → failed_permanent →
// pipeline_run.status='failed'.
//
// Fix: validation, confidence, composition agents now use
// tryResolveHypothesisIdForRun (returns null) and skip cleanly instead
// of throwing. Matches the pattern already used by problem-based
// (hypothesis, competitiveAnalysis via tryResolveProblemIdForRun) and
// candidate-based (scoring, cm2, founderFit via tryResolveCandidateIdForRun)
// agents.
//
// The end-to-end invariant this pins: a fresh Stripe-originated run
// whose Discovery produces no markets must complete with all steps
// 'succeeded' (each with a `skipReason`), NOT fail with a confusing
// "no hypothesis found" error at Validation.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../../db/client";
import { runValidationAgent } from "../validationAgent";
import { runConfidenceAgent } from "../confidenceAgent";
import { runCompositionAgent } from "../compositionAgent";
import type { LLMClient } from "../../../sandbox/llmClient";

// A run with NO upstream data — mirrors the ba923046 case exactly.
const RUN_ID = "f867b348-4444-4000-a000-000000000040";
const AUTH_USER_ID = "f867b348-4444-4000-a000-000000000041";

// Trivial mock LLM — never invoked because the agents skip before
// reaching any LLM call.
const noopLlm: LLMClient = {
  generate: async () => ({ text: "", raw: {} }),
} as unknown as LLMClient;

describe("Upstream skip cascade: hypothesis-based agents skip cleanly when no hypothesis exists", () => {
  let founderId: string;

  beforeAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });

    const founder = await prisma.founder.create({
      data: { authUserId: AUTH_USER_ID, expertise: [], industries: [], constraints: [] },
    });
    founderId = founder.id;
    await prisma.pipelineRun.create({
      data: { runId: RUN_ID, founderId, vertical: "shopify_subscriptions" },
    });
    // DO NOT create any hypothesis, problem, market, etc. — mirrors
    // the ba923046 state precisely.
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    await prisma.$disconnect();
  });

  it("runValidationAgent skips with clear reason instead of throwing 'no active hypothesis found'", async () => {
    const result = await runValidationAgent(RUN_ID, undefined, noopLlm);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("no active hypothesis");
    // Explicit anti-regression: the pre-fix behaviour was to throw
    // exactly this text via resolveHypothesisIdForRun.
    expect(result.skipReason).not.toContain("resolveHypothesisIdForRun");
  });

  it("runConfidenceAgent skips with clear reason instead of throwing", async () => {
    const result = await runConfidenceAgent(RUN_ID, undefined, noopLlm);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("no active hypothesis");
  });

  it("runCompositionAgent skips with clear reason instead of throwing", async () => {
    const result = await runCompositionAgent(RUN_ID, undefined);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("no active hypothesis");
    expect(result.candidateId).toBeNull();
  });

  it("all three agents together: none throw, none produce output — clean partial completion", async () => {
    // Directly reproduces the ba923046 downstream cascade end-to-end
    // (without running the full worker + BullMQ stack). If any of these
    // throws, the run's status would flip to 'failed' rather than
    // completing with skipReasons.
    const [v, c, comp] = await Promise.all([
      runValidationAgent(RUN_ID, undefined, noopLlm),
      runConfidenceAgent(RUN_ID, undefined, noopLlm),
      runCompositionAgent(RUN_ID, undefined),
    ]);
    expect(v.skipped).toBe(true);
    expect(c.skipped).toBe(true);
    expect(comp.skipped).toBe(true);
  });
});
