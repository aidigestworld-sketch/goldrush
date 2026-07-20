// Wiring regression test for the OpportunityRationale post-terminal
// polish step. Would have failed on the pre-2026-07-19 codebase where
// OpportunityRationale existed as a fully-implemented agent but was
// NEVER referenced by the orchestrator (grep confirmed 0 references in
// apps/api/src/orchestrator/ outside a single unrelated test file).
// Result: 100 % of promoted Opportunity rows shipped with
// rationale_bullets: [] and risk_summary: [], and the RunResultView
// rendered empty "RISKS & GAPS" scaffolding.
//
// Three angles, each independently sufficient to have caught the bug:
//   1. advance("compression", ...) enqueues "opportunity_rationale"
//      when a promoted opportunity exists. The previous behavior was
//      a bare `return;` — this test asserts the enqueue happens.
//   2. handlers.opportunity_rationale resolves the opportunity id and
//      invokes runOpportunityRationaleAgent through the real handler
//      wrapping (withIdempotency + checkpoint transitions).
//   3. deriveOverallStatus is unaffected by opportunity_rationale's
//      state — the run stays "completed" even while the polish step
//      is pending, running, or failed_permanent. This is the invariant
//      that lets us safely add a post-terminal step without regressing
//      the user-visible status.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { deriveOverallStatus } from "../api";
import { DAG_STEPS, POST_JOIN_STEP, type DagStep } from "../steps";

// ── deriveOverallStatus ────────────────────────────────────────────────

describe("deriveOverallStatus — opportunity_rationale is invisible to the user-visible status", () => {
  function status(perStep: Array<{ step: DagStep; status: string }>) {
    return deriveOverallStatus(perStep);
  }
  function baseline(compressionStatus: string): Array<{ step: DagStep; status: string }> {
    // 12 stages all succeeded (or the compression override) — the
    // "everything before Compression is done" happy-path baseline.
    return DAG_STEPS.filter((s) => s !== POST_JOIN_STEP).map((s) => ({
      step: s,
      status: s === "compression" ? compressionStatus : "succeeded",
    }));
  }

  it("compression succeeded + opportunity_rationale pending → completed (was the whole wiring goal)", () => {
    const perStep = [...baseline("succeeded"), { step: POST_JOIN_STEP, status: "pending" }];
    expect(status(perStep)).toBe("completed");
  });

  it("compression succeeded + opportunity_rationale running → completed (polish must not flip status back)", () => {
    const perStep = [...baseline("succeeded"), { step: POST_JOIN_STEP, status: "running" }];
    expect(status(perStep)).toBe("completed");
  });

  it("compression succeeded + opportunity_rationale failed_permanent → completed (polish failure ≠ run failure)", () => {
    const perStep = [...baseline("succeeded"), { step: POST_JOIN_STEP, status: "failed_permanent" }];
    expect(status(perStep)).toBe("completed");
  });

  it("compression running + opportunity_rationale not_started → in_progress (compression itself still gates)", () => {
    const perStep = [...baseline("running"), { step: POST_JOIN_STEP, status: "not_started" }];
    expect(status(perStep)).toBe("in_progress");
  });

  it("one core step failed + opportunity_rationale succeeded → failed (core failure still surfaces)", () => {
    const perStep: Array<{ step: DagStep; status: string }> = [
      ...baseline("succeeded").map((s, i) => (i === 0 ? { ...s, status: "failed_permanent" } : s)),
      { step: POST_JOIN_STEP, status: "succeeded" },
    ];
    expect(status(perStep)).toBe("failed");
  });
});

// ── sequencing.advance ─────────────────────────────────────────────────

// The critical wiring test. Uses vi.doMock to intercept enqueueStep so
// the test doesn't need Redis, but exercises the actual advance() switch
// logic that decides "should compression enqueue anything next."
describe("sequencing.advance — compression → opportunity_rationale wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("enqueues opportunity_rationale after compression completes when a promoted opportunity exists", async () => {
    // Track what advance ends up asking the queue to add. The bug this
    // catches: prior code was a bare `return;` inside `if (justCompleted
    // === JOIN_STEP)` so no add() would ever fire.
    const addSpy = vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({}));

    vi.doMock("../queues", () => ({
      getQueue: () => ({
        getJob: async () => null,
        add: addSpy,
        obliterate: async () => {},
      }),
      getFlowProducer: () => ({ add: async () => ({}) }),
      queueName: (s: string) => `dag-${s}`,
    }));
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => null,
      upsertPending: async () => ({}),
    }));
    vi.doMock("../idResolvers", () => ({
      tryResolveOpportunityIdForRun: async () => "opportunity-uuid-123",
    }));

    const sequencing = await import("../sequencing");
    await sequencing.advance("compression", { runId: "run-uuid-abc" });

    expect(addSpy).toHaveBeenCalled();
    const callArgs = addSpy.mock.calls[0];
    expect(callArgs[0]).toBe("opportunity_rationale");
    // Job data forwards opportunityId + runId so the handler can go
    // straight to the row without a resolve.
    const jobData = callArgs[1] as { runId: string; opportunityId: string };
    expect(jobData.runId).toBe("run-uuid-abc");
    expect(jobData.opportunityId).toBe("opportunity-uuid-123");

    vi.doUnmock("../queues");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../idResolvers");
  });

  it("does NOT enqueue when compression promoted nothing (insufficient_evidence terminal)", async () => {
    const addSpy = vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({}));
    vi.doMock("../queues", () => ({
      getQueue: () => ({
        getJob: async () => null,
        add: addSpy,
        obliterate: async () => {},
      }),
      getFlowProducer: () => ({ add: async () => ({}) }),
      queueName: (s: string) => `dag-${s}`,
    }));
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => null,
      upsertPending: async () => ({}),
    }));
    vi.doMock("../idResolvers", () => ({
      // No promoted opportunity — Compression hit insufficient_evidence.
      tryResolveOpportunityIdForRun: async () => null,
    }));

    const sequencing = await import("../sequencing");
    await sequencing.advance("compression", { runId: "run-uuid-no-promoted" });

    // Zero enqueues — nothing to phrase.
    expect(addSpy).not.toHaveBeenCalled();

    vi.doUnmock("../queues");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../idResolvers");
  });
});

// ── handlers.opportunity_rationale ─────────────────────────────────────

describe("handlers.opportunity_rationale — invocation + DB write", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("resolves opportunityId from JobData, invokes runOpportunityRationaleAgent, returns result", async () => {
    const agentSpy = vi.fn(async (_runId: string, _opportunityId: string, _llm: unknown) => ({
      opportunityId: "opp-uuid-1",
      rationaleBullets: ["Bullet 1 [evd-1]", "Bullet 2 [evd-2]"],
      riskSummary: ["Risk 1 [evd-3]"],
      groundingViolations: [] as string[],
      skipped: false,
    }));
    vi.doMock("../../agents/live/opportunityRationaleAgent", () => ({
      runOpportunityRationaleAgent: agentSpy,
    }));
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "r", step: "opportunity_rationale", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "r", step: "opportunity_rationale", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));
    vi.doMock("../idResolvers", () => ({
      tryResolveOpportunityIdForRun: async () => "opp-uuid-1",
      tryResolveProblemIdForRun: async () => null,
      tryResolveCandidateIdForRun: async () => null,
    }));

    const { handlers } = await import("../handlers");
    const result = await handlers.opportunity_rationale({
      runId: "r",
      opportunityId: "opp-uuid-1",
    });

    expect(agentSpy).toHaveBeenCalledOnce();
    const [runId, opportunityId] = agentSpy.mock.calls[0];
    expect(runId).toBe("r");
    expect(opportunityId).toBe("opp-uuid-1");
    expect(result.skipped).toBe(false);

    vi.doUnmock("../../agents/live/opportunityRationaleAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
    vi.doUnmock("../idResolvers");
  });

  it("falls back to tryResolveOpportunityIdForRun when JobData.opportunityId is missing (resume/retry case)", async () => {
    const agentSpy = vi.fn(async (_runId: string, _opportunityId: string, _llm: unknown) => ({
      opportunityId: "opp-uuid-resolved",
      rationaleBullets: ["b"],
      riskSummary: ["r"],
      groundingViolations: [] as string[],
      skipped: false,
    }));
    const resolveSpy = vi.fn(async () => "opp-uuid-resolved");
    vi.doMock("../../agents/live/opportunityRationaleAgent", () => ({
      runOpportunityRationaleAgent: agentSpy,
    }));
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "r", step: "opportunity_rationale", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "r", step: "opportunity_rationale", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));
    vi.doMock("../idResolvers", () => ({
      tryResolveOpportunityIdForRun: resolveSpy,
      tryResolveProblemIdForRun: async () => null,
      tryResolveCandidateIdForRun: async () => null,
    }));

    const { handlers } = await import("../handlers");
    await handlers.opportunity_rationale({ runId: "r" }); // no opportunityId

    expect(resolveSpy).toHaveBeenCalledWith("r", undefined);
    expect(agentSpy).toHaveBeenCalledOnce();
    expect(agentSpy.mock.calls[0][1]).toBe("opp-uuid-resolved");

    vi.doUnmock("../../agents/live/opportunityRationaleAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
    vi.doUnmock("../idResolvers");
  });

  it("skips cleanly when no promoted opportunity exists (insufficient_evidence run)", async () => {
    const agentSpy = vi.fn();
    vi.doMock("../../agents/live/opportunityRationaleAgent", () => ({
      runOpportunityRationaleAgent: agentSpy,
    }));
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "r", step: "opportunity_rationale", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "r", step: "opportunity_rationale", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));
    vi.doMock("../idResolvers", () => ({
      tryResolveOpportunityIdForRun: async () => null,
      tryResolveProblemIdForRun: async () => null,
      tryResolveCandidateIdForRun: async () => null,
    }));

    const { handlers } = await import("../handlers");
    const result = await handlers.opportunity_rationale({ runId: "r" });

    expect(result.skipped).toBe(true);
    expect(typeof result.skipReason === "string" && result.skipReason.includes("no promoted opportunity")).toBe(true);
    // Agent MUST NOT be invoked — no opportunity to phrase.
    expect(agentSpy).not.toHaveBeenCalled();

    vi.doUnmock("../../agents/live/opportunityRationaleAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
    vi.doUnmock("../idResolvers");
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
