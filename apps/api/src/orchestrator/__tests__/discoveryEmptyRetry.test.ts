// Regression test for the Discovery retry-on-empty-markets handler logic.
//
// Prior behavior (before this fix): if Discovery ran successfully but
// returned marketsCreated=0 (transient mid-tier model output-quality
// miss — the ba923046 case on 2026-07-15), the pipeline accepted the
// empty result and cascaded skips all the way to Compression's
// insufficient_evidence terminal state, wasting 5-15 minutes of
// downstream retries.
//
// Fix: mirror expansion handler's existing pattern — throw a transient
// error on `!result.skipped && result.marketsCreated === 0` so BullMQ
// retries the step. Bounded rule violations (brvCount > 0) also throw
// for retry.
//
// The critical distinction the fix preserves:
//   - Legitimately skipped run (no evidence for the vertical) → does NOT
//     throw, exits cleanly. Retries would not manufacture evidence.
//   - Ran-but-empty run (evidence exists, model produced nothing) → throws.

import { describe, it, expect } from "vitest";
import { handlers } from "../handlers";

// The handler under test dispatches to runDiscoveryAgent which we don't
// mock — we mock it by replacing the module registration path. Simpler:
// wrap the handler with a stubbed result object that mimics both
// scenarios and confirm the throw/no-throw behaviour.
//
// The handler function is: (data) => withIdempotency("discovery", data, async () => { const result = await runDiscoveryAgent(...); ... }).
// We can't easily inject a fake runDiscoveryAgent without vi.mock. Use
// vi.doMock to swap the module before importing the handlers.

import { vi } from "vitest";

describe("handlers.discovery — retry-on-empty invariant", () => {
  it("empty markets + not skipped → throws for BullMQ retry (the ba923046 case)", async () => {
    vi.resetModules();
    vi.doMock("../../agents/live/discoveryAgent", () => ({
      runDiscoveryAgent: async () => ({
        marketsCreated: 0,
        boundedRuleViolations: [],
        skipped: false,
      }),
    }));
    // Return a pending row from getRow so withIdempotency doesn't
    // short-circuit — this test targets the retry-on-empty invariant,
    // not the phantom-job skip path (which is covered by
    // checkpointIdempotency.test.ts).
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "x", step: "discovery", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "x", step: "discovery", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));

    const { handlers: h } = await import("../handlers");
    await expect(
      h.discovery({ runId: "test-run-empty" })
    ).rejects.toThrow(/produced 0 markets/);

    vi.doUnmock("../../agents/live/discoveryAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
  });

  it("bounded-rule violations → throws for BullMQ retry (same as Expansion pattern)", async () => {
    vi.resetModules();
    vi.doMock("../../agents/live/discoveryAgent", () => ({
      runDiscoveryAgent: async () => ({
        marketsCreated: 0,
        boundedRuleViolations: ["Market cites hallucinated evidence_ref evd-foo"],
        skipped: true,
        skipReason: "Bounded Rule violations found",
      }),
    }));
    // Return a pending row from getRow so withIdempotency doesn't
    // short-circuit — this test targets the retry-on-empty invariant,
    // not the phantom-job skip path (which is covered by
    // checkpointIdempotency.test.ts).
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "x", step: "discovery", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "x", step: "discovery", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));

    const { handlers: h } = await import("../handlers");
    await expect(h.discovery({ runId: "test-run-brv" })).rejects.toThrow(/bounded-rule violation/);

    vi.doUnmock("../../agents/live/discoveryAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
  });

  it("legitimately skipped (no evidence for vertical) → does NOT throw, exits cleanly", async () => {
    // The scenario the user was explicit about preserving: a founder's
    // vertical genuinely has no evidence rows. Retries can't manufacture
    // evidence, so the handler must accept the skip and let the pipeline
    // resolve to insufficient_evidence via the cascade + Compression.
    vi.resetModules();
    vi.doMock("../../agents/live/discoveryAgent", () => ({
      runDiscoveryAgent: async () => ({
        marketsCreated: 0,
        boundedRuleViolations: [],
        skipped: true,
        skipReason: "no active evidence of an allowed source_type exists",
      }),
    }));
    // Return a pending row from getRow so withIdempotency doesn't
    // short-circuit — this test targets the retry-on-empty invariant,
    // not the phantom-job skip path (which is covered by
    // checkpointIdempotency.test.ts).
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "x", step: "discovery", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "x", step: "discovery", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));

    const { handlers: h } = await import("../handlers");
    // Must NOT throw — a clean skip is a valid terminal state.
    const result = await h.discovery({ runId: "test-run-no-evidence" });
    expect(result).toBeDefined();

    vi.doUnmock("../../agents/live/discoveryAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
  });

  it("normal happy path (markets created) → does NOT throw", async () => {
    vi.resetModules();
    vi.doMock("../../agents/live/discoveryAgent", () => ({
      runDiscoveryAgent: async () => ({
        marketsCreated: 4,
        boundedRuleViolations: [],
        skipped: false,
      }),
    }));
    // Return a pending row from getRow so withIdempotency doesn't
    // short-circuit — this test targets the retry-on-empty invariant,
    // not the phantom-job skip path (which is covered by
    // checkpointIdempotency.test.ts).
    vi.doMock("../checkpoint.repository", () => ({
      getRow: async () => ({ status: "pending", runId: "x", step: "discovery", attemptCount: 0 }),
      markRunning: async () => ({ status: "running", runId: "x", step: "discovery", attemptCount: 1 }),
      markSucceeded: async () => {},
    }));
    vi.doMock("../llmFactory", () => ({
      makeNimLlmForAgent: async () => ({}),
    }));

    const { handlers: h } = await import("../handlers");
    const result = await h.discovery({ runId: "test-run-happy" });
    expect(result).toBeDefined();

    vi.doUnmock("../../agents/live/discoveryAgent");
    vi.doUnmock("../checkpoint.repository");
    vi.doUnmock("../llmFactory");
  });
});
