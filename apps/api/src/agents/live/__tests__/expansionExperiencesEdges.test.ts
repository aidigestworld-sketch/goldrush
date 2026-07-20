// Integration test for the audience↔problem `experiences` edge fix.
//
// Motivating incident: run d84f73a7-da62-4ce6-8f33-7c8ead81f8ca finished
// with 0 opportunity_candidate rows and status='insufficient_evidence'
// despite a validation_score=0.82 hypothesis, because Composition's
// audience-lookup came back empty — no `experiences` edges linked the
// extracted audience to the problem. This test pins the fix at the
// integration level (real Prisma writes, stubbed sandbox for
// determinism) so a regression can't silently re-introduce the same
// "every run is insufficient_evidence regardless of quality" behavior.
//
// Two verified paths:
//   1. explicit-labels — sandbox emits experiencing_audience_labels
//      matching real audiences → agent writes precise per-problem edges
//   2. cartesian-fallback — sandbox omits the field entirely → agent
//      links every problem to every audience for the market
//      (conservative safe default that guarantees Composition can
//      proceed)
//
// A third assertion runs Composition's actual audience-lookup query
// against the DB after Expansion — the same shape compositionAgent.ts
// uses at line 119-121 — and confirms it returns non-empty. That's the
// specific behavior the gap-comment at compositionAgent.ts:122
// documented, so this is the exact regression coverage the task asked
// for.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../../db/client";

const AUTH_USER_ID = "f867b348-7777-4000-a000-000000000090";
const RUN_ID = "f867b348-7777-4000-a000-000000000091";
const MARKET_ID = "f867b348-7777-4000-a000-000000000092";
const VERTICAL = "test-vertical-experiences-edges";

async function cleanup() {
  // Order matters — dependent rows first.
  await prisma.agentExecutionLog.deleteMany({ where: { runId: RUN_ID } });
  const problems = await prisma.problem.findMany({ where: { pipelineRunId: RUN_ID }, select: { id: true } });
  const audiences = await prisma.audience.findMany({ where: { pipelineRunId: RUN_ID }, select: { id: true } });
  const problemIds = problems.map((p) => p.id);
  const audienceIds = audiences.map((a) => a.id);
  if (problemIds.length > 0) {
    await prisma.nodeSourceRef.deleteMany({ where: { nodeId: { in: problemIds } } });
    await prisma.edge.deleteMany({ where: { toId: { in: problemIds } } });
  }
  if (audienceIds.length > 0) {
    await prisma.nodeSourceRef.deleteMany({ where: { nodeId: { in: audienceIds } } });
    await prisma.edge.deleteMany({ where: { OR: [{ fromId: { in: audienceIds } }, { toId: { in: audienceIds } }] } });
  }
  await prisma.edge.deleteMany({ where: { OR: [{ fromId: MARKET_ID }, { toId: MARKET_ID }] } });
  await prisma.problem.deleteMany({ where: { pipelineRunId: RUN_ID } });
  await prisma.audience.deleteMany({ where: { pipelineRunId: RUN_ID } });
  await prisma.evidence.deleteMany({ where: { vertical: VERTICAL } });
  await prisma.market.deleteMany({ where: { id: MARKET_ID } });
  await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
  await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
}

async function seed(): Promise<void> {
  await cleanup();
  const founder = await prisma.founder.create({
    data: { authUserId: AUTH_USER_ID, expertise: [], industries: [], constraints: [] },
  });
  await prisma.pipelineRun.create({
    data: { runId: RUN_ID, founderId: founder.id, vertical: VERTICAL },
  });
  await prisma.market.create({
    data: { id: MARKET_ID, label: "Test market", status: "active", maturityStage: "growing", categoryTags: [], pipelineRunId: RUN_ID },
  });
  // One evidence row so runExpansionAgent doesn't take the "no evidence" skip.
  await prisma.evidence.create({
    data: {
      sourceType: "review_complaint",
      vertical: VERTICAL,
      status: "active",
      sourceUrlOrIdentifier: "test-complaint-01",
      extractedFact: "customers hate that they can't tell why churn happened",
      sourceAuthorityTier: "medium",
      extractionMethod: "test-fixture",
      fetchedAt: new Date(),
    },
  });
}

describe("Expansion writes experiences edges (fix for compositionAgent.ts:122 gap)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    await cleanup();
    vi.doUnmock("../../../sandbox/expansionSandbox");
  });

  it("explicit labels: creates a distinct experiences edge for each declared audience", async () => {
    await seed();
    vi.doMock("../../../sandbox/expansionSandbox", () => ({
      runExpansionSandbox: async () => ({
        rawResponse: "{}",
        parsed: {
          audiences: [
            { label: "Merchants running subscriptions", description: null, evidence_refs: [] },
            { label: "Support agents", description: null, evidence_refs: [] },
          ],
          problems: [
            {
              label: "No way to distinguish accidental vs intentional cancellations",
              problem_maturity: "recognized_unsolved",
              current_workaround_description: null,
              severity_signal: null,
              severity_evidence_quote: null,
              frequency_signal: null,
              frequency_evidence_quote: null,
              evidence_refs: [],
              // Explicit linkage — only the merchant audience experiences THIS problem.
              experiencing_audience_labels: ["Merchants running subscriptions"],
            },
            {
              label: "No visibility into which subscriptions were auto-cancelled",
              problem_maturity: "recognized_unsolved",
              current_workaround_description: null,
              severity_signal: null,
              severity_evidence_quote: null,
              frequency_signal: null,
              frequency_evidence_quote: null,
              evidence_refs: [],
              experiencing_audience_labels: ["Merchants running subscriptions", "Support agents"],
            },
          ],
        },
        validationErrors: [],
        boundedRuleViolations: [],
        repaired: false,
        retried: false,
        fabricationStrips: { severity: 0, frequency: 0 },
      }),
    }));
    const { runExpansionAgent } = await import("../expansionAgent");
    const result = await runExpansionAgent(RUN_ID, MARKET_ID, { complete: async () => "" } as never);
    expect(result.skipped).toBe(false);
    expect(result.audiencesCreated).toBe(2);
    expect(result.problemsCreated).toBe(2);
    // Problem 1: 1 audience. Problem 2: 2 audiences. Total = 3 edges.
    expect(result.experiencesEdgesCreated).toBe(3);

    // Real DB check: Composition's actual audience-lookup query
    // (compositionAgent.ts:119-121 shape) — must return non-empty.
    const problems = await prisma.problem.findMany({ where: { pipelineRunId: RUN_ID } });
    for (const p of problems) {
      const edges = await prisma.edge.findMany({
        where: { edgeType: "experiences", toId: p.id, toType: "problem" },
      });
      expect(edges.length).toBeGreaterThan(0);
    }
  });

  it("Cartesian fallback: LLM omits labels → problem linked to EVERY audience for the market", async () => {
    await seed();
    vi.doMock("../../../sandbox/expansionSandbox", () => ({
      runExpansionSandbox: async () => ({
        rawResponse: "{}",
        parsed: {
          audiences: [
            { label: "Aud A", description: null, evidence_refs: [] },
            { label: "Aud B", description: null, evidence_refs: [] },
          ],
          problems: [
            {
              label: "No way to X",
              problem_maturity: "recognized_unsolved",
              current_workaround_description: null,
              severity_signal: null,
              severity_evidence_quote: null,
              frequency_signal: null,
              frequency_evidence_quote: null,
              evidence_refs: [],
              // experiencing_audience_labels omitted — agent must fall back.
            },
          ],
        },
        validationErrors: [],
        boundedRuleViolations: [],
        repaired: false,
        retried: false,
        fabricationStrips: { severity: 0, frequency: 0 },
      }),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runExpansionAgent } = await import("../expansionAgent");
    const result = await runExpansionAgent(RUN_ID, MARKET_ID, { complete: async () => "" } as never);
    expect(result.skipped).toBe(false);
    // 1 problem × 2 audiences (Cartesian fallback) = 2 experiences edges.
    expect(result.experiencesEdgesCreated).toBe(2);
    // Fallback warn fires so we can observe how often the model omits the field.
    const fallbackWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("[Expansion] experiencing_audience_labels fallback"));
    expect(fallbackWarns.length).toBe(1);
    expect(fallbackWarns[0]).toContain("1/1 problems");

    // Real DB check: Composition's audience-lookup returns 2 audiences for the one problem.
    const problems = await prisma.problem.findMany({ where: { pipelineRunId: RUN_ID } });
    expect(problems.length).toBe(1);
    const edges = await prisma.edge.findMany({
      where: { edgeType: "experiences", toId: problems[0].id, toType: "problem" },
    });
    expect(edges.length).toBe(2);
    warnSpy.mockRestore();
  });
});
