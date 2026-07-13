import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runFilteringAgent } from "../filteringAgent";
import { runDiscoveryAgent } from "../discoveryAgent";
import { runExpansionAgent } from "../expansionAgent";
import type { LLMClient } from "../../../sandbox/llmClient";
import { prisma } from "../../../db/client";

const REAL_FOUNDER_ID = "fd88ecae-5bf3-4289-a13e-6278a484eed9";
const TAG = "test-isolation-";
const SHOPIFY_VERTICAL = "shopify_subscriptions";
const B2B_VERTICAL = "b2b_customer_support_saas";

const createdRunIds: string[] = [];
const createdMarketIds: string[] = [];
const createdAudienceIds: string[] = [];
const createdProblemIds: string[] = [];
const createdEvidenceIds: string[] = [];

async function makeRun(vertical: string, stage = "discovery"): Promise<string> {
  const run = await prisma.pipelineRun.create({
    data: { founderId: REAL_FOUNDER_ID, vertical, currentStage: stage, status: "running" },
  });
  createdRunIds.push(run.runId);
  return run.runId;
}

async function seedEvidence(opts: { vertical: string; sourceType: string; marker: string }): Promise<string> {
  const row = await prisma.evidence.create({
    data: {
      sourceUrlOrIdentifier: `https://test.example.com/${opts.marker}`,
      sourceType: opts.sourceType,
      sourceAuthorityTier: "forum_post",
      extractionMethod: "llm_extraction",
      extractedFact: `ISOLATION_TEST_${opts.marker}`,
      fetchedAt: new Date(),
      status: "active",
      vertical: opts.vertical,
    },
  });
  createdEvidenceIds.push(row.id);
  return row.id;
}

function makeCapturingLlm(staticResponse: string): { llm: LLMClient; capturedUserPrompts: string[] } {
  const capturedUserPrompts: string[] = [];
  const llm: LLMClient = {
    async complete(_system: string, user: string): Promise<string> {
      capturedUserPrompts.push(user);
      return staticResponse;
    },
  };
  return { llm, capturedUserPrompts };
}

describe("run-scoping isolation", () => {
  afterAll(async () => {
    await prisma.agentExecutionLog.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.nodeSourceRef.deleteMany({ where: { evidenceId: { in: createdEvidenceIds } } });
    await prisma.market.deleteMany({ where: { id: { in: createdMarketIds } } });
    await prisma.audience.deleteMany({ where: { id: { in: createdAudienceIds } } });
    await prisma.problem.deleteMany({ where: { id: { in: createdProblemIds } } });
    await prisma.evidence.deleteMany({ where: { id: { in: createdEvidenceIds } } });
    await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.$disconnect();
  });

  describe("1. Filtering cross-run isolation", () => {
    it("runFilteringAgent(runA) deprecates only runA's nodes; runB's nodes untouched", async () => {
      const runAId = await makeRun(SHOPIFY_VERTICAL, "filtering");
      const runBId = await makeRun(B2B_VERTICAL, "filtering");

      const marketA = await prisma.market.create({
        data: { label: `${TAG}market-runA-low`, maturityStage: "growing", confidence: 0.1, pipelineRunId: runAId },
      });
      createdMarketIds.push(marketA.id);

      const marketB = await prisma.market.create({
        data: { label: `${TAG}market-runB-low`, maturityStage: "growing", confidence: 0.1, pipelineRunId: runBId },
      });
      createdMarketIds.push(marketB.id);

      await runFilteringAgent(runAId, { minConfidence: 0.5 });

      const [afterA, afterB] = await Promise.all([
        prisma.market.findUnique({ where: { id: marketA.id }, select: { status: true } }),
        prisma.market.findUnique({ where: { id: marketB.id }, select: { status: true } }),
      ]);

      expect(afterA?.status).toBe("deprecated");
      expect(afterB?.status).toBe("active");
    });
  });

  describe("2. Discovery cross-vertical evidence isolation", () => {
    it("runDiscoveryAgent(b2bRun) LLM prompt contains only b2b evidence, not shopify", async () => {
      const b2bRunId = await makeRun(B2B_VERTICAL, "discovery");

      await seedEvidence({ vertical: SHOPIFY_VERTICAL, sourceType: "search_signal", marker: "SHOPIFY_DISCOVERY" });
      await seedEvidence({ vertical: B2B_VERTICAL, sourceType: "search_signal", marker: "B2B_DISCOVERY" });

      const { llm, capturedUserPrompts } = makeCapturingLlm('{ "markets": [] }');
      const result = await runDiscoveryAgent(b2bRunId, llm);

      expect(result.skipped).toBe(false);
      expect(capturedUserPrompts.length).toBe(1);

      const prompt = capturedUserPrompts[0] ?? "";
      expect(prompt.includes("ISOLATION_TEST_B2B_DISCOVERY")).toBe(true);
      expect(prompt.includes("ISOLATION_TEST_SHOPIFY_DISCOVERY")).toBe(false);
    });
  });

  describe("3. Expansion cross-vertical evidence isolation", () => {
    it("runExpansionAgent(b2bRun) LLM prompt contains only b2b evidence, not shopify", async () => {
      const b2bRunId = await makeRun(B2B_VERTICAL, "expansion");

      await seedEvidence({ vertical: SHOPIFY_VERTICAL, sourceType: "review_complaint", marker: "SHOPIFY_EXPANSION" });
      await seedEvidence({ vertical: B2B_VERTICAL, sourceType: "review_complaint", marker: "B2B_EXPANSION" });

      const testMarket = await prisma.market.create({
        data: { label: `${TAG}market-for-expansion`, maturityStage: "growing", pipelineRunId: b2bRunId },
      });
      createdMarketIds.push(testMarket.id);

      const { llm, capturedUserPrompts } = makeCapturingLlm('{ "audiences": [], "problems": [] }');
      const result = await runExpansionAgent(b2bRunId, testMarket.id, llm);

      expect(result.skipped).toBe(false);
      expect(capturedUserPrompts.length).toBe(1);

      const prompt = capturedUserPrompts[0] ?? "";
      expect(prompt.includes("ISOLATION_TEST_B2B_EXPANSION")).toBe(true);
      expect(prompt.includes("ISOLATION_TEST_SHOPIFY_EXPANSION")).toBe(false);
    });
  });
});
