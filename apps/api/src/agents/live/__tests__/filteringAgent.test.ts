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
  let audienceHighId: string, audienceLowId: string;
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

  it("wrapper ran (not skipped) and perType covers 3 types", () => {
    expect(result.skipped).toBe(false);
    expect(result.perType.length).toBe(3);
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

  it("audience-high survives; audience-low deprecated", async () => {
    const audienceAfter = await prisma.audience.findMany({
      where: { id: { in: createdAudienceIds } },
      select: { id: true, status: true, deprecationReason: true },
    });
    expect(audienceAfter.find((r) => r.id === audienceHighId)?.status).toBe("active");
    const aLow = audienceAfter.find((r) => r.id === audienceLowId);
    expect(aLow?.status).toBe("deprecated");
    expect(aLow?.deprecationReason).toBe("below_confidence_threshold");
  });

  it("problem-high survives", async () => {
    const problemAfter = await prisma.problem.findMany({
      where: { id: { in: createdProblemIds } },
      select: { id: true, status: true },
    });
    expect(problemAfter.find((r) => r.id === problemHighId)?.status).toBe("active");
  });

  it("agent_execution_log: status=success, graph_mutation_count >= 3, model_used=null", async () => {
    const logs = await prisma.agentExecutionLog.findMany({
      where: { runId: testRunId, agentName: "Filtering" },
      orderBy: { startedAt: "desc" },
      take: 1,
    });
    expect(logs.length === 1 && logs[0].status === "success").toBe(true);
    expect((logs[0].graphMutationCount ?? 0) >= 3).toBe(true);
    expect(logs[0].modelUsed).toBeNull();
  });
});
