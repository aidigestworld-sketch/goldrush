import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runConfidenceMode2Agent } from "../confidenceMode2Agent";
import { opportunityCandidateRepository } from "../../../repositories/opportunityCandidate.repository";
import { prisma } from "../../../db/client";
import crypto from "crypto";

const RUN_ID = "28e862eb-7d47-4c8c-aa7d-66510bbe0166";
const TEST_EVIDENCE_URL_PREFIX = "https://test-fixture.local/confidence-mode2-agent";

const createdCandidateIds: string[] = [];
const createdEvidenceIds: string[] = [];

async function seedEvidenceRow(polarity: "supporting" | "contradicting", ageDays: number) {
  const fetchedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  const row = await prisma.evidence.create({
    data: {
      sourceUrlOrIdentifier: `${TEST_EVIDENCE_URL_PREFIX}/${crypto.randomUUID()}`,
      sourceType: "review_complaint",
      sourceAuthorityTier: "review_verified",
      extractionMethod: "test_seed",
      extractionConfidence: 0.9,
      extractedFact: `test evidence (${polarity}, age ${ageDays}d)`,
      fetchedAt,
    },
  });
  createdEvidenceIds.push(row.id);
  return row.id;
}

async function seedCandidateWithComposition(options: {
  compositionRoles: readonly ("market" | "audience" | "problem" | "hypothesis" | "business_model")[];
  hypothesisEvidence?: { evidenceId: string; polarity: "supporting" | "contradicting" }[];
  otherSlotEvidence?: { role: "market" | "audience" | "problem" | "business_model"; evidenceId: string; polarity: "supporting" | "contradicting" }[];
  seedFounderFit?: { score: number; rationale: string };
}) {
  const candidate = await prisma.opportunityCandidate.create({
    data: {
      runId: RUN_ID,
      opportunityQuality: 0.5,
      ...(options.seedFounderFit
        ? { founderFitScore: options.seedFounderFit.score, founderFitRationale: options.seedFounderFit.rationale }
        : {}),
    },
  });
  createdCandidateIds.push(candidate.id);

  const rolesToNodeIds = new Map<string, string>();
  for (const role of options.compositionRoles) {
    const nodeId = crypto.randomUUID();
    rolesToNodeIds.set(role, nodeId);
    await prisma.opportunityCandidateComposition.create({
      data: { candidateId: candidate.id, nodeId, nodeType: role, role },
    });
  }

  const hypothesisNodeId = rolesToNodeIds.get("hypothesis");
  if (hypothesisNodeId && options.hypothesisEvidence) {
    for (const ev of options.hypothesisEvidence) {
      await prisma.nodeSourceRef.create({
        data: { nodeId: hypothesisNodeId, nodeType: "hypothesis", evidenceId: ev.evidenceId, evidencePolarity: ev.polarity },
      });
    }
  }

  if (options.otherSlotEvidence) {
    for (const ev of options.otherSlotEvidence) {
      const nodeId = rolesToNodeIds.get(ev.role);
      if (!nodeId) continue;
      await prisma.nodeSourceRef.create({
        data: { nodeId, nodeType: ev.role, evidenceId: ev.evidenceId, evidencePolarity: ev.polarity },
      });
    }
  }

  return { candidateId: candidate.id, rolesToNodeIds };
}

async function cleanup() {
  if (createdCandidateIds.length > 0) {
    if (createdEvidenceIds.length > 0) {
      await prisma.nodeSourceRef.deleteMany({ where: { evidenceId: { in: createdEvidenceIds } } });
    }
    await prisma.opportunityCandidateComposition.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
    await prisma.agentExecutionLog.deleteMany({ where: { candidateId: { in: createdCandidateIds } } });
    await prisma.opportunityCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  }
  if (createdEvidenceIds.length > 0) {
    await prisma.evidence.deleteMany({ where: { id: { in: createdEvidenceIds } } });
  }
}

describe("confidenceMode2Agent live wrapper", () => {
  let eS1: string, eS2: string, eS3: string, eC1: string;

  beforeAll(async () => {
    eS1 = await seedEvidenceRow("supporting", 1);
    eS2 = await seedEvidenceRow("supporting", 2);
    eS3 = await seedEvidenceRow("supporting", 5);
    eC1 = await seedEvidenceRow("contradicting", 3);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe("(1) normal write path", () => {
    it("writes all 5 owned columns with correct values; agreement = 0.75 (3S/1C)", async () => {
      const normal = await seedCandidateWithComposition({
        compositionRoles: ["market", "audience", "problem", "hypothesis", "business_model"],
        hypothesisEvidence: [
          { evidenceId: eS1, polarity: "supporting" },
          { evidenceId: eS2, polarity: "supporting" },
          { evidenceId: eS3, polarity: "supporting" },
          { evidenceId: eC1, polarity: "contradicting" },
        ],
      });

      const normalResult = await runConfidenceMode2Agent(RUN_ID, normal.candidateId);
      expect(normalResult.skipped).toBe(false);
      expect(normalResult.coverageGate).toBe(1);
      expect(normalResult.incompleteComposition).toBe(false);
      expect(Math.abs((normalResult.agreement ?? -1) - 0.75) < 0.0001).toBe(true);
      expect(Math.abs((normalResult.confidenceScore ?? -1) - 0.75) < 0.0001).toBe(true);
      expect(normalResult.freshness !== null && normalResult.freshness > 0.9).toBe(true);

      const normalRow = await prisma.opportunityCandidate.findUnique({ where: { id: normal.candidateId } });
      expect(normalRow?.confidenceCoverageGate).toBe(true);
      expect(normalRow?.incompleteComposition).toBe(false);
      expect(Math.abs((normalRow?.confidenceAgreement ?? -1) - 0.75) < 0.001).toBe(true);
      expect(Math.abs((normalRow?.confidenceScore ?? -1) - 0.75) < 0.001).toBe(true);
      expect(normalRow?.confidenceFreshness !== null && (normalRow?.confidenceFreshness ?? 0) > 0.9).toBe(true);
    });
  });

  describe("(2) incomplete-composition short-circuit", () => {
    it("writes incomplete-state row with coverage_gate=false, agreement/freshness/confidence=null", async () => {
      const incomplete = await seedCandidateWithComposition({
        compositionRoles: ["market", "audience", "hypothesis"],
        hypothesisEvidence: [
          { evidenceId: eS1, polarity: "supporting" },
          { evidenceId: eC1, polarity: "contradicting" },
        ],
      });

      const incResult = await runConfidenceMode2Agent(RUN_ID, incomplete.candidateId);
      expect(incResult.skipped).toBe(false);
      expect(incResult.coverageGate).toBe(0);
      expect(incResult.incompleteComposition).toBe(true);
      expect(incResult.agreement).toBeNull();
      expect(incResult.freshness).toBeNull();
      expect(incResult.confidenceScore).toBeNull();

      const incRow = await prisma.opportunityCandidate.findUnique({ where: { id: incomplete.candidateId } });
      expect(incRow?.confidenceCoverageGate).toBe(false);
      expect(incRow?.incompleteComposition).toBe(true);
      expect(incRow?.confidenceAgreement).toBeNull();
      expect(incRow?.confidenceFreshness).toBeNull();
      expect(incRow?.confidenceScore).toBeNull();
    });
  });

  describe("(3) disjoint-column concurrency vs FounderFit", () => {
    it("Mode 2 UPDATE leaves FounderFit columns untouched, and parallel updates don't overwrite each other", async () => {
      const FF_SCORE_BEFORE = 42;
      const FF_RATIONALE_BEFORE = "TEST_PRESET_FOUNDER_FIT_RATIONALE";
      const concurrent = await seedCandidateWithComposition({
        compositionRoles: ["market", "audience", "problem", "hypothesis", "business_model"],
        hypothesisEvidence: [
          { evidenceId: eS1, polarity: "supporting" },
          { evidenceId: eS2, polarity: "supporting" },
        ],
        seedFounderFit: { score: FF_SCORE_BEFORE, rationale: FF_RATIONALE_BEFORE },
      });

      await runConfidenceMode2Agent(RUN_ID, concurrent.candidateId);
      const afterMode2 = await prisma.opportunityCandidate.findUnique({ where: { id: concurrent.candidateId } });
      expect(afterMode2?.founderFitScore).toBe(FF_SCORE_BEFORE);
      expect(afterMode2?.founderFitRationale).toBe(FF_RATIONALE_BEFORE);
      expect(afterMode2?.confidenceCoverageGate).toBe(true);
      expect(Math.abs((afterMode2?.confidenceAgreement ?? -1) - 1.0) < 0.001).toBe(true);

      // Reset Mode 2 fields to NULL so we can observe a fresh concurrent write.
      await prisma.opportunityCandidate.update({
        where: { id: concurrent.candidateId },
        data: {
          confidenceScore: null, confidenceAgreement: null, confidenceFreshness: null,
          confidenceCoverageGate: null, incompleteComposition: null,
        },
      });

      const NEW_FF_SCORE = 77;
      const NEW_FF_RATIONALE = "TEST_CONCURRENT_FF";
      await Promise.all([
        runConfidenceMode2Agent(RUN_ID, concurrent.candidateId),
        opportunityCandidateRepository.setFounderFit(concurrent.candidateId, NEW_FF_SCORE, NEW_FF_RATIONALE),
      ]);

      const afterConcurrent = await prisma.opportunityCandidate.findUnique({ where: { id: concurrent.candidateId } });
      expect(afterConcurrent?.founderFitScore).toBe(NEW_FF_SCORE);
      expect(afterConcurrent?.founderFitRationale).toBe(NEW_FF_RATIONALE);
      expect(afterConcurrent?.confidenceCoverageGate).toBe(true);
      expect(Math.abs((afterConcurrent?.confidenceAgreement ?? -1) - 1.0) < 0.001).toBe(true);
    });
  });
});
