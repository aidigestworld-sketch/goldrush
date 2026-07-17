// Per-agent integration tests for the token-budget wiring.
//
// The shared selector's own semantics live in
// src/sandbox/__tests__/tokenBudget.test.ts. These tests confirm the
// specific WIRING of each agent — that the agent calls the selector
// between evidence fetch and sandbox call, drops rows correctly, and
// logs the "[Agent] token-budget: kept X/Y ... dropped by source_type"
// message when any drop happens.
//
// Approach: stub the sandbox module for each agent to capture the
// `documents` array actually passed to the LLM. Seed the DB with a
// corpus large enough to force the selector to drop rows. Assert
// documents.length < evidenceRows.length AND the "token-budget: kept"
// warning was logged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../../db/client";
import { runDiscoveryAgent } from "../discoveryAgent";
import { runExpansionAgent } from "../expansionAgent";
import { runCompetitiveAnalysisAgent } from "../competitiveAnalysisAgent";
import {
  DEFAULT_INPUT_TOKEN_BUDGET,
  CHARS_PER_TOKEN_CONSERVATIVE,
  MODEL_INPUT_TOKEN_BUDGETS,
  getInputTokenBudgetForModel,
  getInputTokenBudgetForAgent,
} from "../../../sandbox/tokenBudget";

const AUTH_USER_ID = "f867b348-7777-4000-a000-000000000070";
const RUN_ID = "f867b348-7777-4000-a000-000000000071";
const MARKET_ID = "f867b348-7777-4000-a000-000000000072";
const PROBLEM_ID = "f867b348-7777-4000-a000-000000000073";
const HYPOTHESIS_ID = "f867b348-7777-4000-a000-000000000074";

// Per-doc chars that will push the corpus past DEFAULT_INPUT_TOKEN_BUDGET.
// budget=100000 tokens ≈ 350000 chars. 60 docs × 8000 chars ≈ 480000 chars —
// well over budget, forcing selector to drop ~30 of them.
const OVERSIZED_DOC_COUNT = 60;
const OVERSIZED_DOC_CHARS = 8_000;

async function seedRun(vertical: string): Promise<string> {
  await cleanup();
  const founder = await prisma.founder.create({
    data: { authUserId: AUTH_USER_ID, expertise: [], industries: [], constraints: [] },
  });
  await prisma.pipelineRun.create({
    data: { runId: RUN_ID, founderId: founder.id, vertical },
  });
  return founder.id;
}

async function cleanup() {
  await prisma.agentExecutionLog.deleteMany({ where: { runId: RUN_ID } });
  await prisma.nodeSourceRef.deleteMany({ where: { nodeId: HYPOTHESIS_ID } });
  await prisma.hypothesis.deleteMany({ where: { id: HYPOTHESIS_ID } });
  await prisma.evidence.deleteMany({ where: { vertical: "test-vertical-tb-integration" } });
  await prisma.market.deleteMany({ where: { id: MARKET_ID } });
  await prisma.problem.deleteMany({ where: { id: PROBLEM_ID } });
  await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
  await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
}

async function seedOversizedEvidence(sourceType: string, vertical: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < OVERSIZED_DOC_COUNT; i++) {
    const row = await prisma.evidence.create({
      data: {
        sourceType,
        vertical,
        status: "active",
        sourceUrlOrIdentifier: `test-${sourceType}-${i}`,
        extractedFact: "x".repeat(OVERSIZED_DOC_CHARS),
        sourceAuthorityTier: "medium",
        extractionMethod: "test-fixture",
        fetchedAt: new Date(Date.now() - i * 60_000),
      },
    });
    ids.push(row.id);
  }
  return ids;
}

describe("Agent token-budget wiring", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    warnSpy.mockRestore();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    warnSpy.mockClear();
    vi.resetModules();
  });

  afterEach(async () => {
    await cleanup();
    vi.doUnmock("../../../sandbox/discoverySandbox");
    vi.doUnmock("../../../sandbox/expansionSandbox");
    vi.doUnmock("../../../sandbox/competitiveAnalysisSandbox");
    vi.doUnmock("../../../sandbox/validationSandbox");
    vi.doUnmock("../../../sandbox/confidenceSandbox");
  });

  it("Discovery drops rows and logs when corpus exceeds budget", async () => {
    const vertical = "test-vertical-tb-integration";
    await seedRun(vertical);
    await seedOversizedEvidence("search_signal", vertical);

    // Stub the sandbox so we can capture what actually gets passed.
    let capturedDocs: Array<{ id: string; text: string }> | null = null;
    vi.doMock("../../../sandbox/discoverySandbox", () => ({
      runDiscoverySandbox: async (
        _llm: unknown,
        docs: Array<{ id: string; text: string }>
      ) => {
        capturedDocs = docs;
        return { rawResponse: '{"markets":[]}', parsed: { markets: [] }, validationErrors: [], boundedRuleViolations: [] };
      },
    }));
    const { runDiscoveryAgent: runDiscoveryAgentWithStub } = await import("../discoveryAgent");

    await runDiscoveryAgentWithStub(RUN_ID, { complete: async () => "" } as never);

    expect(capturedDocs).not.toBeNull();
    // Budget must have dropped rows: fewer selected than the raw corpus.
    expect(capturedDocs!.length).toBeLessThan(OVERSIZED_DOC_COUNT);
    // Estimated tokens on the selected batch stay within budget.
    const totalChars = capturedDocs!.reduce((s, d) => s + d.text.length, 0);
    const estTokens = Math.ceil(totalChars / CHARS_PER_TOKEN_CONSERVATIVE);
    expect(estTokens).toBeLessThanOrEqual(DEFAULT_INPUT_TOKEN_BUDGET);

    // Log fired with the expected shape.
    const relevantWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("[Discovery] token-budget"));
    expect(relevantWarns.length).toBe(1);
    expect(relevantWarns[0]).toMatch(/kept \d+\/\d+ evidence rows/);
    expect(relevantWarns[0]).toContain("dropped by source_type");
  });

  it("Expansion drops rows and logs when review_complaint corpus exceeds budget", async () => {
    const vertical = "test-vertical-tb-integration";
    await seedRun(vertical);
    await seedOversizedEvidence("review_complaint", vertical);
    await prisma.market.create({
      data: {
        id: MARKET_ID,
        label: "Test market",
        status: "active",
        maturityStage: "growing",
        categoryTags: [],
        pipelineRunId: RUN_ID,
      },
    });

    let capturedDocs: Array<{ id: string; text: string }> | null = null;
    vi.doMock("../../../sandbox/expansionSandbox", () => ({
      runExpansionSandbox: async (
        _llm: unknown,
        docs: Array<{ id: string; text: string }>,
        _label: string
      ) => {
        capturedDocs = docs;
        return {
          rawResponse: '{"audiences":[],"problems":[]}',
          parsed: { audiences: [], problems: [] },
          validationErrors: [],
          boundedRuleViolations: [],
          repaired: false,
          retried: false,
          strippedByFieldByProblem: {},
        };
      },
    }));
    const { runExpansionAgent: runExpansionAgentWithStub } = await import("../expansionAgent");

    await runExpansionAgentWithStub(RUN_ID, MARKET_ID, { complete: async () => "" } as never);

    expect(capturedDocs).not.toBeNull();
    expect(capturedDocs!.length).toBeLessThan(OVERSIZED_DOC_COUNT);
    const relevantWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("[Expansion] token-budget"));
    expect(relevantWarns.length).toBe(1);
    expect(relevantWarns[0]).toMatch(/kept \d+\/\d+ evidence rows/);
  });

  it("CompetitiveAnalysis drops rows and logs when competitor_material corpus exceeds budget", async () => {
    const vertical = "test-vertical-tb-integration";
    await seedRun(vertical);
    const evidenceIds = await seedOversizedEvidence("competitor_material", vertical);
    await prisma.problem.create({
      data: {
        id: PROBLEM_ID,
        label: "Test problem",
        problemMaturity: "recognized_unsolved",
        status: "active",
        pipelineRunId: RUN_ID,
      },
    });

    let capturedDocs: Array<{ id: string; text: string }> | null = null;
    vi.doMock("../../../sandbox/competitiveAnalysisSandbox", () => ({
      runCompetitiveAnalysisSandbox: async (
        _llm: unknown,
        docs: Array<{ id: string; text: string }>
      ) => {
        capturedDocs = docs;
        return {
          rawResponse: '{"existing_solutions":[],"business_models":[]}',
          parsed: { existing_solutions: [], business_models: [] },
          validationErrors: [],
          boundedRuleViolations: [],
          sourceAttributionWarnings: [],
        };
      },
    }));
    const { runCompetitiveAnalysisAgent: runCA } = await import("../competitiveAnalysisAgent");

    // CA groups evidence by competitor name.
    const competitorMap = new Map<string, string[]>();
    competitorMap.set("Recharge", evidenceIds.slice(0, 20));
    competitorMap.set("Bold Subscriptions", evidenceIds.slice(20, 40));
    competitorMap.set("Loop Subscriptions", evidenceIds.slice(40, 60));

    await runCA(RUN_ID, PROBLEM_ID, competitorMap, { complete: async () => "" } as never);

    expect(capturedDocs).not.toBeNull();
    expect(capturedDocs!.length).toBeLessThan(OVERSIZED_DOC_COUNT);
    const relevantWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("[CompetitiveAnalysis] token-budget"));
    expect(relevantWarns.length).toBe(1);
    expect(relevantWarns[0]).toMatch(/kept \d+\/\d+ evidence rows/);
  });

  it("Validation drops rows and logs when combined (corpus + search) pool exceeds budget", async () => {
    const vertical = "test-vertical-tb-integration";
    const founderId = await seedRun(vertical);
    // Uncited-in-vertical evidence — Validation reads all active,
    // uncited-by-hypothesis rows scoped to the run's vertical. Any
    // source_type is eligible for the classifier corpus.
    await seedOversizedEvidence("competitor_material", vertical);
    // Seed a hypothesis so runValidationAgent doesn't skip.
    await prisma.hypothesis.create({
      data: {
        id: HYPOTHESIS_ID,
        statement: "test hypothesis for token-budget wiring",
        gapType: "unaddressed_pain",
        missingData: [],
        status: "active",
        pipelineRunId: RUN_ID,
      },
    });
    // sanity: avoid unused-var lint on founderId (the founder is
    // referenced transitively via pipeline_run.founder_id).
    expect(founderId).toBeTruthy();

    let capturedCandidates: Array<{ id: string; text: string }> | null = null;
    vi.doMock("../../../sandbox/validationSandbox", () => ({
      // Agent now calls the batched wrapper — stub that instead. This test
      // exercises the token-budget SELECTION path, not the batching path,
      // so we don't need to simulate the batch-split behaviour here.
      runValidationSandboxBatched: async (
        _llm: unknown,
        input: { candidates: Array<{ id: string; text: string }> }
      ) => {
        capturedCandidates = input.candidates;
        return {
          rawResponse: '{"classified_evidence":[],"unresolved_questions":[],"additional_search_queries_would_run":[]}',
          parsed: {
            classified_evidence: [],
            unresolved_questions: [],
            additional_search_queries_would_run: [],
          },
          validationErrors: [],
          boundedRuleViolations: [],
        };
      },
    }));
    const { runValidationAgent: runValidationAgentWithStub } = await import("../validationAgent");

    // No searchProvider — the corpus alone is oversized enough to force
    // the selector to drop. Passing model=nano-9b so the budget looked
    // up matches DEFAULT_INPUT_TOKEN_BUDGET.
    await runValidationAgentWithStub(RUN_ID, HYPOTHESIS_ID, {
      complete: async () => "",
      model: "nvidia/nvidia-nemotron-nano-9b-v2",
    } as never);

    expect(capturedCandidates).not.toBeNull();
    expect(capturedCandidates!.length).toBeLessThan(OVERSIZED_DOC_COUNT);
    const totalChars = capturedCandidates!.reduce((s, d) => s + d.text.length, 0);
    const estTokens = Math.ceil(totalChars / CHARS_PER_TOKEN_CONSERVATIVE);
    expect(estTokens).toBeLessThanOrEqual(DEFAULT_INPUT_TOKEN_BUDGET);

    const relevantWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("[Validation] token-budget"));
    expect(relevantWarns.length).toBe(1);
    expect(relevantWarns[0]).toMatch(/kept \d+\/\d+ evidence rows/);
    expect(relevantWarns[0]).toContain("dropped by source_type");
  });

  it("Confidence drops cited-evidence rows and logs when they exceed budget", async () => {
    const vertical = "test-vertical-tb-integration";
    await seedRun(vertical);
    const evidenceIds = await seedOversizedEvidence("industry_report", vertical);
    await prisma.hypothesis.create({
      data: {
        id: HYPOTHESIS_ID,
        statement: "test hypothesis for Confidence token-budget wiring",
        gapType: "unaddressed_pain",
        missingData: [],
        status: "active",
        validationScore: null,
        pipelineRunId: RUN_ID,
      },
    });
    // Cite every seeded evidence row on this hypothesis so the cited
    // pool matches the oversized-corpus size. Alternate polarities so
    // both supporting and contradicting split lists have content.
    await prisma.nodeSourceRef.createMany({
      data: evidenceIds.map((evidenceId, i) => ({
        nodeId: HYPOTHESIS_ID,
        nodeType: "hypothesis",
        evidenceId,
        evidencePolarity: i % 2 === 0 ? "supporting" : "contradicting",
      })),
    });

    let capturedFor: Array<{ id: string; text: string }> | null = null;
    let capturedAgainst: Array<{ id: string; text: string }> | null = null;
    vi.doMock("../../../sandbox/confidenceSandbox", async () => {
      const actual: object = await vi.importActual("../../../sandbox/confidenceSandbox");
      return {
        ...actual,
        runConfidenceSandbox: async (
          _llm: unknown,
          input: {
            evidenceFor: Array<{ id: string; text: string }>;
            evidenceAgainst: Array<{ id: string; text: string }>;
          }
        ) => {
          capturedFor = input.evidenceFor;
          capturedAgainst = input.evidenceAgainst;
          return {
            rawResponse: '{"validation_score":0.6}',
            parsed: { validation_score: 0.6 },
            validationErrors: [],
            boundedRuleViolations: [],
          };
        },
      };
    });
    const { runConfidenceAgent: runConfidenceAgentWithStub } = await import("../confidenceAgent");

    await runConfidenceAgentWithStub(RUN_ID, HYPOTHESIS_ID, {
      complete: async () => "",
      model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    } as never);

    expect(capturedFor).not.toBeNull();
    expect(capturedAgainst).not.toBeNull();
    const totalKept = capturedFor!.length + capturedAgainst!.length;
    expect(totalKept).toBeLessThan(OVERSIZED_DOC_COUNT);

    const relevantWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("[Confidence] token-budget"));
    expect(relevantWarns.length).toBe(1);
    expect(relevantWarns[0]).toMatch(/kept \d+\/\d+ evidence rows/);
  });

  it("per-agent+model budget override: Validation on super-49b gets the tighter 75K budget", () => {
    // Regression for the 2026-07-16 mitigation: three consecutive NIM
    // 504s at ~105K input on Validation+super-49b prompted a per-agent
    // override that trades ~25% fewer candidates for lower gateway
    // pressure. Pin the value so a future refactor of the override
    // table can't silently restore the pre-fix 105K budget.
    expect(
      getInputTokenBudgetForAgent("Validation", "nvidia/llama-3.3-nemotron-super-49b-v1")
    ).toBe(75_000);

    // Regression for the 2026-07-17 v1.5 rename: budget lookup was
    // previously keyed to the exact NIM catalog id "-v1", so switching
    // routing to "-v1.5" silently dropped the override and Validation
    // fell back to the shared DEFAULT (100K) — the OPPOSITE of what
    // the routing switch was trying to achieve. baseModelKey-based
    // lookup makes the override survive point-release renames.
    expect(
      getInputTokenBudgetForAgent("Validation", "nvidia/llama-3.3-nemotron-super-49b-v1.5")
    ).toBe(75_000);

    // Other agents on the same super-49b class keep the model-wide
    // budget (105K) — the override is Validation-specific — and both
    // -v1 and -v1.5 resolve to the same class budget.
    expect(
      getInputTokenBudgetForAgent("Confidence", "nvidia/llama-3.3-nemotron-super-49b-v1")
    ).toBe(getInputTokenBudgetForModel("nvidia/llama-3.3-nemotron-super-49b-v1"));
    expect(
      getInputTokenBudgetForAgent("Hypothesis", "nvidia/llama-3.3-nemotron-super-49b-v1")
    ).toBe(105_000);
    expect(
      getInputTokenBudgetForAgent("Hypothesis", "nvidia/llama-3.3-nemotron-super-49b-v1.5")
    ).toBe(105_000);

    // Validation on a DIFFERENT model class (nano-9b) falls through
    // to the model-only budget — the override is (agent, class)-
    // specific, not agent-blanket.
    expect(
      getInputTokenBudgetForAgent("Validation", "nvidia/nvidia-nemotron-nano-9b-v2")
    ).toBe(getInputTokenBudgetForModel("nvidia/nvidia-nemotron-nano-9b-v2"));

    // Unknown model / no model → DEFAULT.
    expect(getInputTokenBudgetForAgent("Validation", undefined)).toBe(DEFAULT_INPUT_TOKEN_BUDGET);
    expect(getInputTokenBudgetForAgent("Validation", null)).toBe(DEFAULT_INPUT_TOKEN_BUDGET);
    expect(getInputTokenBudgetForAgent("Validation", "unknown/fake-model")).toBe(
      DEFAULT_INPUT_TOKEN_BUDGET
    );
  });

  it("per-model budget lookup: mid-tier super-49b gets a higher budget than nano-9b's DEFAULT", () => {
    // Sanity: MODEL_INPUT_TOKEN_BUDGETS is populated with both known
    // classes, and the mid-tier class gets more headroom than the shared
    // 100K default. This ties the "per-model, not one-size-fits-all"
    // design decision into an executable assertion — if someone
    // regresses either budget the test flags it before a live run does.
    // Both -v1 and -v1.5 must resolve to the same class-wide value.
    const nano = getInputTokenBudgetForModel("nvidia/nvidia-nemotron-nano-9b-v2");
    const midV1 = getInputTokenBudgetForModel("nvidia/llama-3.3-nemotron-super-49b-v1");
    const midV15 = getInputTokenBudgetForModel("nvidia/llama-3.3-nemotron-super-49b-v1.5");
    expect(nano).toBe(DEFAULT_INPUT_TOKEN_BUDGET);
    expect(midV1).toBeGreaterThan(DEFAULT_INPUT_TOKEN_BUDGET);
    expect(midV1).toBeLessThanOrEqual(131_072 - 16_384);
    expect(midV15).toBe(midV1);
    expect(MODEL_INPUT_TOKEN_BUDGETS["nvidia/llama-3.3-nemotron-super-49b"]).toBe(midV1);

    // Unknown model falls back to DEFAULT.
    expect(getInputTokenBudgetForModel("unknown/fake-model")).toBe(DEFAULT_INPUT_TOKEN_BUDGET);
    expect(getInputTokenBudgetForModel(undefined)).toBe(DEFAULT_INPUT_TOKEN_BUDGET);
    expect(getInputTokenBudgetForModel(null)).toBe(DEFAULT_INPUT_TOKEN_BUDGET);
  });

  it("no drop, no log: agents don't emit the token-budget warning when the whole corpus fits", async () => {
    // Small corpus — 3 rows × 500 chars = 1500 chars, ~430 tokens. Way under budget.
    const vertical = "test-vertical-tb-integration";
    await seedRun(vertical);
    for (let i = 0; i < 3; i++) {
      await prisma.evidence.create({
        data: {
          sourceType: "search_signal",
          vertical,
          status: "active",
          sourceUrlOrIdentifier: `tiny-${i}`,
          extractedFact: "y".repeat(500),
          sourceAuthorityTier: "medium",
          extractionMethod: "test-fixture",
          fetchedAt: new Date(),
        },
      });
    }

    vi.doMock("../../../sandbox/discoverySandbox", () => ({
      runDiscoverySandbox: async () => ({
        rawResponse: '{"markets":[]}',
        parsed: { markets: [] },
        validationErrors: [],
        boundedRuleViolations: [],
      }),
    }));
    const { runDiscoveryAgent: runD } = await import("../discoveryAgent");
    await runD(RUN_ID, { complete: async () => "" } as never);

    const relevantWarns = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((s) => s.includes("token-budget"));
    expect(relevantWarns.length).toBe(0);
  });
});
