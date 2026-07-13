import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { evidenceRepository } from "../evidence.repository";
import { prisma } from "../../db/client";
import type { NormalizedEvidence } from "../../pipeline/types";

const TEST_URL_PREFIX = "https://test-fixture.local/evidence-repo-test";

const testRows: NormalizedEvidence[] = [
  {
    sourceUrlOrIdentifier: `${TEST_URL_PREFIX}/1`,
    sourceType: "review_complaint",
    sourceAuthorityTier: "review_verified",
    extractionMethod: "html_parse",
    extractionConfidence: 0.9,
    extractedFact: "Test evidence row 1",
    fetchedAt: new Date(),
    sourcePublishedAt: null,
    freshness: 1.0,
  },
  {
    sourceUrlOrIdentifier: `${TEST_URL_PREFIX}/1`,
    sourceType: "review_complaint",
    sourceAuthorityTier: "review_verified",
    extractionMethod: "html_parse",
    extractionConfidence: 0.85,
    extractedFact: "Test evidence row 2",
    fetchedAt: new Date(),
    sourcePublishedAt: null,
    freshness: 1.0,
  },
];

describe("evidence.repository — real Prisma persistence", () => {
  let createResult: { count: number };

  beforeAll(async () => {
    await prisma.evidence.deleteMany({ where: { sourceUrlOrIdentifier: { startsWith: TEST_URL_PREFIX } } });
    createResult = await evidenceRepository.createMany(testRows, "shopify_subscriptions");
  });

  afterAll(async () => {
    await prisma.evidence.deleteMany({ where: { sourceUrlOrIdentifier: { startsWith: TEST_URL_PREFIX } } });
    await prisma.$disconnect();
  });

  it("createMany reports count=2", () => {
    expect(createResult.count).toBe(2);
  });

  it("findBySourceUrl returns both rows with correct default status/verificationStatus", async () => {
    const found = await evidenceRepository.findBySourceUrl(`${TEST_URL_PREFIX}/1`);
    expect(found.length).toBe(2);
    expect(found.every((r) => r.status === "active" && r.verificationStatus === "unverified")).toBe(true);
    expect(
      found.some((r) => r.extractedFact === "Test evidence row 1") &&
        found.some((r) => r.extractedFact === "Test evidence row 2")
    ).toBe(true);
  });

  it("countBySourceType includes at least the 2 test rows", async () => {
    const countBefore = await evidenceRepository.countBySourceType("review_complaint");
    expect(countBefore).toBeGreaterThanOrEqual(2);
  });

  it("createMany([]) is a safe no-op", async () => {
    const emptyResult = await evidenceRepository.createMany([], "shopify_subscriptions");
    expect(emptyResult.count).toBe(0);
  });
});
