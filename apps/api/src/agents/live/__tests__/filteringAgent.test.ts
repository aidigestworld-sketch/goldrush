import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runFilteringAgent } from "../filteringAgent";
import { prisma } from "../../../db/client";

const REAL_FOUNDER_ID = "fd88ecae-5bf3-4289-a13e-6278a484eed9";
const TAG = "test-filtering-";

const createdRunIds: string[] = [];
const createdMarketIds: string[] = [];
const createdAudienceIds: string[] = [];
const createdProblemIds: string[] = [];

describe("filteringAgent live wrapper", () => {
  let testRunId: string;
  let marketHighId: string, marketLowId: string, marketNullId: string;
  let audienceHighId: string, audienceLowId: string, audienceNullId: string;
  let problemHighId: string;
  let result: Awaited<ReturnType<typeof runFilteringAgent>>;

  beforeAll(async () => {
    const run = await prisma.pipelineRun.create({
      data: { founderId: REAL_FOUNDER_ID, vertical: "shopify_subscriptions", currentStage: "filtering", status: "running" },
    });
    testRunId = run.runId;
    createdRunIds.push(testRunId);

    const marketHigh = await prisma.market.create({
      data: { label: `${TAG}market-high`, maturityStage: "growing", confidence: 0.9, pipelineRunId: testRunId },
    });
    marketHighId = marketHigh.id;
    createdMarketIds.push(marketHighId);

    const marketLow = await prisma.market.create({
      data: { label: `${TAG}market-low`, maturityStage: "growing", confidence: 0.2, pipelineRunId: testRunId },
    });
    marketLowId = marketLow.id;
    createdMarketIds.push(marketLowId);

    const marketNull = await prisma.market.create({
      data: { label: `${TAG}market-null`, maturityStage: "growing", confidence: null, pipelineRunId: testRunId },
    });
    marketNullId = marketNull.id;
    createdMarketIds.push(marketNullId);

    // Three audiences covering the three confidence states — even
    // "low confidence" and "null confidence" must survive Filtering
    // now, because Filtering's scope was narrowed to {market, problem}
    // on 2026-07-16 (see filteringAgent.ts header). The audience-null
    // case is the specific state Expansion produces by construction
    // (AudienceCandidateSchema has no confidence field), and the fact
    // that Filtering was deprecating THAT was the root cause of run
    // 58895448's zero-candidate result.
    const audienceHigh = await prisma.audience.create({
      data: { label: `${TAG}audience-high`, confidence: 0.8, pipelineRunId: testRunId },
    });
    audienceHighId = audienceHigh.id;
    createdAudienceIds.push(audienceHighId);

    const audienceLow = await prisma.audience.create({
      data: { label: `${TAG}audience-low`, confidence: 0.1, pipelineRunId: testRunId },
    });
    audienceLowId = audienceLow.id;
    createdAudienceIds.push(audienceLowId);

    // The state Expansion actually writes today — the specific case
    // that broke run 58895448.
    audienceNullId = (
      await prisma.audience.create({
        data: { label: `${TAG}audience-null`, confidence: null, pipelineRunId: testRunId },
      })
    ).id;
    createdAudienceIds.push(audienceNullId);

    const problemHigh = await prisma.problem.create({
      data: { label: `${TAG}problem-high`, problemMaturity: "chronic", confidence: 0.7, pipelineRunId: testRunId },
    });
    problemHighId = problemHigh.id;
    createdProblemIds.push(problemHighId);

    result = await runFilteringAgent(testRunId, { minConfidence: 0.5 });
  });

  afterAll(async () => {
    await prisma.agentExecutionLog.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.market.deleteMany({ where: { id: { in: createdMarketIds } } });
    await prisma.audience.deleteMany({ where: { id: { in: createdAudienceIds } } });
    await prisma.problem.deleteMany({ where: { id: { in: createdProblemIds } } });
    await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.$disconnect();
  });

  it("wrapper ran (not skipped) and perType covers exactly {market, problem} — audience is deliberately excluded", () => {
    // Filtering's scope was narrowed on 2026-07-16 (see filteringAgent.ts
    // header). Pin the exact scope so a future refactor that
    // accidentally re-adds audience trips this test and forces the
    // audience-null / observable-proxy discussion to happen again.
    expect(result.skipped).toBe(false);
    expect(result.perType.length).toBe(2);
    const nodeTypes = result.perType.map((p) => p.nodeType).sort();
    expect(nodeTypes).toEqual(["market", "problem"]);
    expect(nodeTypes).not.toContain("audience");
  });

  it("market-high (conf 0.9) survives; market-low deprecated; market-null deprecated with missing_confidence", async () => {
    const marketAfter = await prisma.market.findMany({
      where: { id: { in: createdMarketIds } },
      select: { id: true, status: true, deprecationReason: true },
    });
    expect(marketAfter.find((r) => r.id === marketHighId)?.status).toBe("active");
    const mLow = marketAfter.find((r) => r.id === marketLowId);
    expect(mLow?.status).toBe("deprecated");
    expect(mLow?.deprecationReason).toBe("below_confidence_threshold");
    const mNull = marketAfter.find((r) => r.id === marketNullId);
    expect(mNull?.status).toBe("deprecated");
    expect(mNull?.deprecationReason).toBe("missing_confidence");
  });

  it("ALL audiences survive regardless of confidence — Filtering does not touch audience rows", async () => {
    // The specific behavior change that closes run 58895448's zero-
    // candidate gap. Filtering deprecating audience-null (the state
    // Expansion always writes) meant Composition's audience-lookup
    // came back empty and no candidate could ever be composed —
    // regardless of hypothesis strength. Pin all three confidence
    // states to guard against a regression to the old scope.
    const audienceAfter = await prisma.audience.findMany({
      where: { id: { in: createdAudienceIds } },
      select: { id: true, status: true, deprecationReason: true },
    });
    for (const audId of [audienceHighId, audienceLowId, audienceNullId]) {
      const row = audienceAfter.find((r) => r.id === audId);
      expect(row?.status).toBe("active");
      expect(row?.deprecationReason).toBeNull();
    }
  });

  it("problem-high survives", async () => {
    const problemAfter = await prisma.problem.findMany({
      where: { id: { in: createdProblemIds } },
      select: { id: true, status: true },
    });
    expect(problemAfter.find((r) => r.id === problemHighId)?.status).toBe("active");
  });

  it("agent_execution_log: status=success, graph_mutation_count >= 2 (market-low + market-null deprecations), model_used=null", async () => {
    // Previously asserted >=3 when audience-low was also being
    // deprecated. Now that audience is out of scope, the fixture
    // deprecations are market-low + market-null only (problem-high
    // survives). Keep the assertion as a lower bound (>=2) so
    // additional non-fixture rows from an earlier test in the same
    // DB don't flake the count.
    const logs = await prisma.agentExecutionLog.findMany({
      where: { runId: testRunId, agentName: "Filtering" },
      orderBy: { startedAt: "desc" },
      take: 1,
    });
    expect(logs.length === 1 && logs[0].status === "success").toBe(true);
    expect((logs[0].graphMutationCount ?? 0) >= 2).toBe(true);
    expect(logs[0].modelUsed).toBeNull();
  });
});
