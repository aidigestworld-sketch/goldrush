// Regression tests for the id-resolvers introduced to prevent the
// "prisma.X.findUnique({ where: { id: undefined } })" bug class for
// Stripe-originated runs (JobData.hypothesisId / problemId / candidateId
// are all optional).
//
// Every fixed agent (composition, validation, confidence, hypothesis,
// competitive_analysis, scoring, confidence_mode2, founder_fit) calls
// one of these resolvers at its entry point, so if the resolver behaves
// correctly for `trackingKey=undefined`, no findUnique with an undefined
// id can reach Prisma from those agents.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  resolveHypothesisIdForRun,
  resolveProblemIdForRun,
  resolveCandidateIdForRun,
  tryResolveProblemIdForRun,
  tryResolveCandidateIdForRun,
} from "../idResolvers";
import { prisma } from "../../db/client";

// Stable UUIDs that won't collide with real run data.
const RUN_ID = "f867b348-1111-4000-a000-000000000010";
const EMPTY_RUN_ID = "f867b348-1111-4000-a000-000000000099";
const AUTH_USER_ID = "f867b348-1111-4000-a000-000000000011";

describe("idResolvers — Stripe-originated run regression", () => {
  let hypothesisId: string;
  let problemId: string;
  let candidateId: string;
  let founderId: string;

  beforeAll(async () => {
    // Clean slate.
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

    const problem = await prisma.problem.create({
      data: {
        label: "test-problem",
        problemMaturity: "recognized_unsolved",
        status: "active",
        pipelineRunId: RUN_ID,
      },
    });
    problemId = problem.id;

    const hyp = await prisma.hypothesis.create({
      data: {
        statement: "Test hypothesis for idResolvers",
        gapType: "positioning",
        missingData: [],
        status: "active",
        pipelineRunId: RUN_ID,
      },
    });
    hypothesisId = hyp.id;

    const cand = await prisma.opportunityCandidate.create({
      data: {
        runId: RUN_ID,
        status: "candidate",
      },
    });
    candidateId = cand.id;
  });

  afterAll(async () => {
    await prisma.opportunityCandidate.deleteMany({ where: { runId: RUN_ID } });
    await prisma.hypothesis.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.problem.deleteMany({ where: { pipelineRunId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    await prisma.$disconnect();
  });

  describe("resolveHypothesisIdForRun", () => {
    it("undefined trackingKey resolves via pipelineRunId fallback (Stripe-originated run)", async () => {
      const resolved = await resolveHypothesisIdForRun(RUN_ID, undefined);
      expect(resolved).toBe(hypothesisId);
    });

    it("valid trackingKey returns the same id", async () => {
      const resolved = await resolveHypothesisIdForRun(RUN_ID, hypothesisId);
      expect(resolved).toBe(hypothesisId);
    });

    it("stale trackingKey falls back to most-recent active for the run", async () => {
      const resolved = await resolveHypothesisIdForRun(RUN_ID, "00000000-0000-0000-0000-000000000000");
      expect(resolved).toBe(hypothesisId);
    });

    it("throws when no hypothesis exists for the run", async () => {
      await expect(resolveHypothesisIdForRun(EMPTY_RUN_ID, undefined)).rejects.toThrow(
        "no active hypothesis found"
      );
    });
  });

  describe("resolveProblemIdForRun + tryResolveProblemIdForRun", () => {
    it("undefined trackingKey resolves via pipelineRunId fallback", async () => {
      const resolved = await resolveProblemIdForRun(RUN_ID, undefined);
      expect(resolved).toBe(problemId);
    });

    it("valid trackingKey returns the same id", async () => {
      const resolved = await resolveProblemIdForRun(RUN_ID, problemId);
      expect(resolved).toBe(problemId);
    });

    it("stale trackingKey falls back to earliest active for the run", async () => {
      const resolved = await resolveProblemIdForRun(RUN_ID, "00000000-0000-0000-0000-000000000000");
      expect(resolved).toBe(problemId);
    });

    it("resolveProblemIdForRun throws when no problem exists", async () => {
      await expect(resolveProblemIdForRun(EMPTY_RUN_ID, undefined)).rejects.toThrow(
        "no active problem found"
      );
    });

    it("tryResolveProblemIdForRun returns null instead of throwing when no problem exists", async () => {
      const resolved = await tryResolveProblemIdForRun(EMPTY_RUN_ID, undefined);
      expect(resolved).toBeNull();
    });

    it("tryResolveProblemIdForRun returns id on happy path", async () => {
      const resolved = await tryResolveProblemIdForRun(RUN_ID, undefined);
      expect(resolved).toBe(problemId);
    });
  });

  describe("resolveCandidateIdForRun + tryResolveCandidateIdForRun", () => {
    it("undefined trackingKey resolves via runId fallback", async () => {
      const resolved = await resolveCandidateIdForRun(RUN_ID, undefined);
      expect(resolved).toBe(candidateId);
    });

    it("valid trackingKey returns the same id", async () => {
      const resolved = await resolveCandidateIdForRun(RUN_ID, candidateId);
      expect(resolved).toBe(candidateId);
    });

    it("stale trackingKey falls back to most-recent 'candidate' status for the run", async () => {
      const resolved = await resolveCandidateIdForRun(RUN_ID, "00000000-0000-0000-0000-000000000000");
      expect(resolved).toBe(candidateId);
    });

    it("resolveCandidateIdForRun throws when no candidate exists", async () => {
      await expect(resolveCandidateIdForRun(EMPTY_RUN_ID, undefined)).rejects.toThrow(
        "no candidate found"
      );
    });

    it("tryResolveCandidateIdForRun returns null instead of throwing when no candidate exists", async () => {
      const resolved = await tryResolveCandidateIdForRun(EMPTY_RUN_ID, undefined);
      expect(resolved).toBeNull();
    });

    it("tryResolveCandidateIdForRun returns id on happy path", async () => {
      const resolved = await tryResolveCandidateIdForRun(RUN_ID, undefined);
      expect(resolved).toBe(candidateId);
    });
  });

  describe("no findUnique with id:undefined ever reaches Prisma", () => {
    // Regression guard for the specific Prisma error text we saw in
    // dag_run_state.last_error on the 07:45 2026-07-14 live run and the
    // later Composition failure that motivated the codebase-wide sweep.
    // Each resolver is tested independently: pass undefined trackingKey
    // AND an empty run, then confirm the error is our thrown "no X found"
    // message rather than Prisma's "Invalid prisma.X.findUnique()
    // invocation" — the exact failure mode we are preventing.
    async function assertOurError(promise: Promise<unknown>, expectedSubstring: string) {
      let err: Error | null = null;
      try {
        await promise;
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain(expectedSubstring);
      expect(err!.message).not.toMatch(/Invalid prisma\..*findUnique.*invocation/i);
    }

    it("hypothesis resolver: undefined + empty run throws our error, not Prisma's", async () => {
      await assertOurError(
        resolveHypothesisIdForRun(EMPTY_RUN_ID, undefined),
        "no active hypothesis found"
      );
    });

    it("problem resolver: undefined + empty run throws our error, not Prisma's", async () => {
      await assertOurError(
        resolveProblemIdForRun(EMPTY_RUN_ID, undefined),
        "no active problem found"
      );
    });

    it("candidate resolver: undefined + empty run throws our error, not Prisma's", async () => {
      await assertOurError(
        resolveCandidateIdForRun(EMPTY_RUN_ID, undefined),
        "no candidate found"
      );
    });
  });
});
