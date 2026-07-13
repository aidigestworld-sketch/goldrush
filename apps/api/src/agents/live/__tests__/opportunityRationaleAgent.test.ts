import { describe, it, expect, afterAll } from "vitest";
import { runOpportunityRationaleAgent } from "../opportunityRationaleAgent";
import { prisma } from "../../../db/client";
import type { LLMClient } from "../../../sandbox/llmClient";

const REAL_FOUNDER_ID = "fd88ecae-5bf3-4289-a13e-6278a484eed9";
const REAL_PROMOTED_CANDIDATE_IDS = [
  "54535c9a-c667-47d5-a7e1-40ff3839a22a",
  "0ea35efe",
];

class MockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({ rationale_bullets: [], risk_summary: [] });
  }
}

const createdRunIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdOpportunityIds: string[] = [];

async function makeTestRun(): Promise<string> {
  const run = await prisma.pipelineRun.create({
    data: { founderId: REAL_FOUNDER_ID, vertical: "shopify_subscriptions", currentStage: "compression", status: "running" },
  });
  createdRunIds.push(run.runId);
  return run.runId;
}

async function seedCandidateWithNullField(
  runId: string,
  nullField: "opportunityQuality" | "confidenceScore" | "founderFitScore"
): Promise<{ candidateId: string; opportunityId: string }> {
  const cand = await prisma.opportunityCandidate.create({
    data: {
      runId,
      opportunityQuality: nullField === "opportunityQuality" ? null : 0.7,
      confidenceScore: nullField === "confidenceScore" ? null : 0.8,
      founderFitScore: nullField === "founderFitScore" ? null : 60,
      status: "promoted",
    },
  });
  createdCandidateIds.push(cand.id);
  const opp = await prisma.opportunity.create({
    data: {
      promotedFromCandidateId: cand.id,
      ventureScore: 0.5,
      confidenceScore: 0.8,
      founderFitScore: 60,
      founderFitRationale: null,
      rationaleBullets: [],
      riskSummary: [],
    },
  });
  createdOpportunityIds.push(opp.id);
  return { candidateId: cand.id, opportunityId: opp.id };
}

afterAll(async () => {
  await prisma.opportunity.deleteMany({ where: { id: { in: createdOpportunityIds } } });
  await prisma.agentExecutionLog.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
  await prisma.opportunityCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  await prisma.agentExecutionLog.deleteMany({ where: { runId: { in: createdRunIds } } });
  await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
  await prisma.$disconnect();
});

describe("P1.2: null-component-throws invariant", () => {
  async function assertThrowsForNullField(
    nullField: "opportunityQuality" | "confidenceScore" | "founderFitScore"
  ) {
    const runId = await makeTestRun();
    const { candidateId, opportunityId } = await seedCandidateWithNullField(runId, nullField);

    let thrown: Error | null = null;
    try {
      await runOpportunityRationaleAgent(runId, opportunityId, new MockLLM());
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message.includes(`null candidate.${nullField}`)).toBe(true);
    expect(thrown?.message.includes(candidateId)).toBe(true);
    expect(thrown?.message.includes("Compression")).toBe(true);

    const oppAfter = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
    expect((oppAfter?.rationaleBullets.length ?? -1) === 0 && (oppAfter?.riskSummary.length ?? -1) === 0).toBe(true);
  }

  it("throws for null opportunityQuality — message names field and candidateId", async () => {
    await assertThrowsForNullField("opportunityQuality");
  });

  it("throws for null confidenceScore — message names field and candidateId", async () => {
    await assertThrowsForNullField("confidenceScore");
  });

  it("throws for null founderFitScore — message names field and candidateId", async () => {
    await assertThrowsForNullField("founderFitScore");
  });
});

describe("P1.2 regression: real promoted candidates are non-null", () => {
  it("each real promoted candidate has non-null opportunityQuality, confidenceScore, founderFitScore", async () => {
    for (const partialId of REAL_PROMOTED_CANDIDATE_IDS) {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; opportunity_quality: number | null; confidence_score: number | null; founder_fit_score: number | null }>
      >(
        `SELECT id, opportunity_quality, confidence_score, founder_fit_score FROM opportunity_candidate WHERE id::text LIKE $1 LIMIT 1`,
        `${partialId}%`
      );
      const cand = rows[0];
      if (!cand) continue; // skip if not present in this DB
      expect(cand.opportunity_quality).not.toBeNull();
      expect(cand.confidence_score).not.toBeNull();
      expect(cand.founder_fit_score).not.toBeNull();
    }
  });
});
