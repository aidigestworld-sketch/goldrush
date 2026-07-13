// Persists NormalizedEvidence rows into the evidence table. This is
// the one place Data Pipeline output actually reaches the DB — no
// agent creates Evidence rows (AI_AGENTS.md's roster only ever reads
// evidence, per the Write Scope Matrix §15; ingestion is deliberately
// non-agent).
import { prisma } from "../db/client";
import type { NormalizedEvidence } from "../pipeline/types";

export const evidenceRepository = {
  // vertical is the run's target vertical (migration 008) — REQUIRED
  // for any live ingest so Discovery Agent can scope its read to the
  // relevant slice of the shared corpus. Passing null here would
  // create an "orphan" row that no run can discover — a latent bug we
  // catch at compile time by making the param required.
  async createMany(rows: NormalizedEvidence[], vertical: string) {
    if (rows.length === 0) return { count: 0 };
    return prisma.evidence.createMany({
      data: rows.map((row) => ({
        sourceUrlOrIdentifier: row.sourceUrlOrIdentifier,
        sourceType: row.sourceType,
        sourceAuthorityTier: row.sourceAuthorityTier,
        extractionMethod: row.extractionMethod,
        extractionConfidence: row.extractionConfidence,
        extractedFact: row.extractedFact,
        fetchedAt: row.fetchedAt,
        sourcePublishedAt: row.sourcePublishedAt,
        vertical,
        freshness: row.freshness,
        verificationStatus: "unverified", // DB default, written explicitly for clarity
        status: "active",
      })),
    });
  },

  findBySourceUrl(sourceUrlOrIdentifier: string) {
    return prisma.evidence.findMany({ where: { sourceUrlOrIdentifier } });
  },

  countBySourceType(sourceType: string) {
    return prisma.evidence.count({ where: { sourceType } });
  },
};
