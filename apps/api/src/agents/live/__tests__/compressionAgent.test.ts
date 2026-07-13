import { describe, it, expect, afterAll } from "vitest";
import { runCompressionAgent } from "../compressionAgent";
import { prisma } from "../../../db/client";
import crypto from "crypto";

const REAL_FOUNDER_ID = "fd88ecae-5bf3-4289-a13e-6278a484eed9";

const createdRunIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdOpportunityIds: string[] = [];
const createdEdgeIds: string[] = [];
const createdEvidenceIds: string[] = [];

async function makeTestRun(): Promise<string> {
  const run = await prisma.pipelineRun.create({
    data: { founderId: REAL_FOUNDER_ID, vertical: "shopify_subscriptions", currentStage: "scoring", status: "running" },
  });
  createdRunIds.push(run.runId);
  return run.runId;
}

async function seedCandidateReady(
  runId: string,
  fields: {
    opportunityQuality: number;
    founderFitScore: number;
    confidenceScore: number | null;
    confidenceAgreement: number | null;
    confidenceFreshness: number | null;
    confidenceCoverageGate: boolean | null;
    incompleteComposition: boolean | null;
  }
): Promise<string> {
  const cand = await prisma.opportunityCandidate.create({
    data: {
      runId,
      opportunityQuality: fields.opportunityQuality,
      founderFitScore: fields.founderFitScore,
      confidenceScore: fields.confidenceScore,
      confidenceAgreement: fields.confidenceAgreement,
      confidenceFreshness: fields.confidenceFreshness,
      confidenceCoverageGate: fields.confidenceCoverageGate,
      incompleteComposition: fields.incompleteComposition,
    },
  });
  createdCandidateIds.push(cand.id);
  for (const role of ["market", "audience", "problem", "hypothesis", "business_model"]) {
    await prisma.opportunityCandidateComposition.create({
      data: { candidateId: cand.id, nodeId: crypto.randomUUID(), nodeType: role, role },
    });
  }
  return cand.id;
}

afterAll(async () => {
  await prisma.edge.deleteMany({ where: { id: { in: createdEdgeIds } } });
  await prisma.opportunity.deleteMany({ where: { id: { in: createdOpportunityIds } } });
  await prisma.agentExecutionLog.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
  await prisma.opportunityCandidateComposition.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
  await prisma.nodeSourceRef.deleteMany({ where: { evidenceId: { in: createdEvidenceIds } } });
  await prisma.opportunityCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  await prisma.evidence.deleteMany({ where: { id: { in: createdEvidenceIds } } });
  await prisma.agentExecutionLog.deleteMany({ where: { runId: { in: createdRunIds } } });
  await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
  await prisma.$disconnect();
});

describe("(1) not_ready short-circuit", () => {
  it("returns notReady=true when candidates are missing 10a or 10b; pipeline_run and candidate rows untouched", async () => {
    const runNotReady = await makeTestRun();

    const missingMode2 = await seedCandidateReady(runNotReady, {
      opportunityQuality: 0.5, founderFitScore: 60,
      confidenceScore: null, confidenceAgreement: null, confidenceFreshness: null,
      confidenceCoverageGate: null, incompleteComposition: null,
    });
    const missingFF = await seedCandidateReady(runNotReady, {
      opportunityQuality: 0.5, founderFitScore: 0,
      confidenceScore: 0.8, confidenceAgreement: 0.8, confidenceFreshness: 0.9,
      confidenceCoverageGate: true, incompleteComposition: false,
    });
    await prisma.opportunityCandidate.update({ where: { id: missingFF }, data: { founderFitScore: null } });

    const runStateBefore = await prisma.pipelineRun.findUnique({ where: { runId: runNotReady } });
    const notReadyResult = await runCompressionAgent(runNotReady);

    expect(notReadyResult.notReady).toBe(true);
    expect(notReadyResult.notReadyDetails?.missingMode2.includes(missingMode2)).toBe(true);
    expect(notReadyResult.notReadyDetails?.missingFounderFit.includes(missingFF)).toBe(true);

    const runStateAfter = await prisma.pipelineRun.findUnique({ where: { runId: runNotReady } });
    expect(
      runStateAfter?.status === runStateBefore?.status &&
        runStateAfter?.currentStage === runStateBefore?.currentStage &&
        runStateAfter?.completedAt === runStateBefore?.completedAt
    ).toBe(true);

    const candStateAfter = await prisma.opportunityCandidate.findMany({
      where: { runId: runNotReady },
      select: { id: true, status: true },
    });
    expect(candStateAfter.every((c) => c.status === "candidate")).toBe(true);
  });
});

describe("(2) full happy-path promotion", () => {
  it("promotes winner, deprecates losers, writes opportunity row, sets pipeline_run terminal state", async () => {
    const runHappy = await makeTestRun();

    const winner = await seedCandidateReady(runHappy, {
      opportunityQuality: 0.7, founderFitScore: 60,
      confidenceScore: 0.9, confidenceAgreement: 0.9, confidenceFreshness: 0.98,
      confidenceCoverageGate: true, incompleteComposition: false,
    });
    const loser1 = await seedCandidateReady(runHappy, {
      opportunityQuality: 0.5, founderFitScore: 60,
      confidenceScore: 0.9, confidenceAgreement: 0.9, confidenceFreshness: 0.98,
      confidenceCoverageGate: true, incompleteComposition: false,
    });
    const loser2 = await seedCandidateReady(runHappy, {
      opportunityQuality: 0.7, founderFitScore: 60,
      confidenceScore: 0.6, confidenceAgreement: 0.6, confidenceFreshness: 0.98,
      confidenceCoverageGate: true, incompleteComposition: false,
    });
    const gapFlagged = await seedCandidateReady(runHappy, {
      opportunityQuality: 0.7, founderFitScore: 60,
      confidenceScore: null, confidenceAgreement: null, confidenceFreshness: null,
      confidenceCoverageGate: false, incompleteComposition: true,
    });

    const happyResult = await runCompressionAgent(runHappy);
    if (happyResult.createdOpportunityId) createdOpportunityIds.push(happyResult.createdOpportunityId);

    expect(happyResult.notReady).toBe(false);
    expect(happyResult.outcome).toBe("promoted");
    expect(happyResult.winnerId).toBe(winner);
    expect(happyResult.createdOpportunityId).not.toBeNull();
    expect(happyResult.incompleteCompositionDeprecated?.includes(gapFlagged)).toBe(true);

    const winnerRow = await prisma.opportunityCandidate.findUnique({ where: { id: winner } });
    expect(winnerRow?.status).toBe("promoted");

    const loser1Row = await prisma.opportunityCandidate.findUnique({ where: { id: loser1 } });
    const loser2Row = await prisma.opportunityCandidate.findUnique({ where: { id: loser2 } });
    expect(loser1Row?.status === "deprecated" && loser1Row.deprecationReason === "lost_tiebreak").toBe(true);
    expect(loser2Row?.status === "deprecated" && loser2Row.deprecationReason === "lost_tiebreak").toBe(true);

    const gapRow = await prisma.opportunityCandidate.findUnique({ where: { id: gapFlagged } });
    expect(gapRow?.status === "deprecated" && gapRow.deprecationReason === "incomplete_composition").toBe(true);

    const oppRow = happyResult.createdOpportunityId
      ? await prisma.opportunity.findUnique({ where: { id: happyResult.createdOpportunityId } })
      : null;
    expect(oppRow?.promotedFromCandidateId).toBe(winner);
    expect(oppRow?.confidenceScore).toBe(0.9);
    expect(oppRow?.founderFitScore).toBe(60);
    expect(Array.isArray(oppRow?.rationaleBullets) && oppRow.rationaleBullets.length === 0).toBe(true);
    expect(Array.isArray(oppRow?.riskSummary) && oppRow.riskSummary.length === 0).toBe(true);

    const edges = await prisma.edge.findMany({
      where: { edgeType: "promotes", fromId: winner, toType: "opportunity" },
    });
    expect(edges.length).toBe(1);
    if (edges.length > 0) createdEdgeIds.push(edges[0].id);

    const runAfter = await prisma.pipelineRun.findUnique({ where: { runId: runHappy } });
    expect(runAfter?.status).toBe("completed");
    expect(runAfter?.currentStage).toBe("completed");
    expect(runAfter?.completedAt).not.toBeNull();

    // P1.3: tiebreak provenance — synthetic composition rows mean operationalComplexityEstimate defaults
    const tiebreakProv = happyResult.tiebreakInputProvenanceByCandidateId ?? [];
    expect(tiebreakProv.length).toBe(3);
    expect(tiebreakProv.every((t) => [winner, loser1, loser2].includes(t.id))).toBe(true);
    const opCompEntries = tiebreakProv.map((t) => t.provenance.find((p) => p.field === "operationalComplexityEstimate"));
    expect(opCompEntries.every((e) => e !== undefined)).toBe(true);
    expect(opCompEntries.every((e) => e?.source === "default")).toBe(true);
    expect(opCompEntries.every((e) => e?.value === 0.5)).toBe(true);

    // Idempotency: re-run finds no candidate rows left to promote
    const rerun = await runCompressionAgent(runHappy);
    expect(rerun.outcome === "insufficient_evidence" || rerun.winnerId === null).toBe(true);
  });
});
