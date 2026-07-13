import { describe, it, expect } from "vitest";
import {
  computeConfidenceMode2,
  COMPOSITION_ROLES,
  DECAY_CONSTANT_DAYS,
  type CompositionSlot,
} from "../confidenceMode2";
import { computeMaxEvidenceRecency } from "../live/compressionRecency";

const NOW = new Date("2026-07-12T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function slotsCitingHypothesisEvidence(evidenceIds: string[]): CompositionSlot[] {
  return COMPOSITION_ROLES.map<CompositionSlot>((role) => ({
    role,
    isNull: false,
    sourceRefs:
      role === "hypothesis"
        ? evidenceIds.map((id) => ({ evidenceId: id, evidencePolarity: "supporting" as const }))
        : [],
  }));
}

describe("P3.2: confidenceMode2 freshness recency", () => {
  it("all-present: freshness reflects sourcePublishedAt (90d = half-life = 0.5), per-row provenance correct", () => {
    const published90d = new Date(NOW.getTime() - DECAY_CONSTANT_DAYS * MS_PER_DAY);
    const out = computeConfidenceMode2({
      slots: slotsCitingHypothesisEvidence(["e1", "e2"]),
      evidence: [
        { evidenceId: "e1", fetchedAt: NOW, sourcePublishedAt: published90d },
        { evidenceId: "e2", fetchedAt: NOW, sourcePublishedAt: published90d },
      ],
      now: NOW,
    });
    expect(Math.abs((out.freshness ?? -1) - 0.5)).toBeLessThanOrEqual(1e-6);
    expect(out.freshnessSourcePublishedCount).toBe(2);
    expect(out.freshnessFallbackCount).toBe(0);
    expect(out.freshnessSources.map((s) => s.usedTimestamp)).toEqual([
      "source_published_at",
      "source_published_at",
    ]);
  });

  it("all-missing: freshness = 1.0 via fetchedAt fallback, fallback path flagged in provenance", () => {
    const out = computeConfidenceMode2({
      slots: slotsCitingHypothesisEvidence(["e1", "e2"]),
      evidence: [
        { evidenceId: "e1", fetchedAt: NOW, sourcePublishedAt: null },
        { evidenceId: "e2", fetchedAt: NOW, sourcePublishedAt: null },
      ],
      now: NOW,
    });
    expect(Math.abs((out.freshness ?? -1) - 1.0)).toBeLessThanOrEqual(1e-6);
    expect(out.freshnessSourcePublishedCount).toBe(0);
    expect(out.freshnessFallbackCount).toBe(2);
    expect(out.freshnessSources.map((s) => s.usedTimestamp)).toEqual([
      "fetched_at_fallback",
      "fetched_at_fallback",
    ]);
  });

  it("mixed: freshness = mean(0.5, 1.0) = 0.75, per-row provenance distinguishes both rows", () => {
    const published90d = new Date(NOW.getTime() - DECAY_CONSTANT_DAYS * MS_PER_DAY);
    const out = computeConfidenceMode2({
      slots: slotsCitingHypothesisEvidence(["ePublished", "eFallback"]),
      evidence: [
        { evidenceId: "ePublished", fetchedAt: NOW, sourcePublishedAt: published90d },
        { evidenceId: "eFallback", fetchedAt: NOW, sourcePublishedAt: null },
      ],
      now: NOW,
    });
    expect(Math.abs((out.freshness ?? -1) - 0.75)).toBeLessThanOrEqual(1e-6);
    expect(out.freshnessSourcePublishedCount).toBe(1);
    expect(out.freshnessFallbackCount).toBe(1);
    const perRow = new Map(out.freshnessSources.map((s) => [s.evidenceId, s.usedTimestamp]));
    expect(perRow.get("ePublished")).toBe("source_published_at");
    expect(perRow.get("eFallback")).toBe("fetched_at_fallback");
  });

  it("sanity: confidence_score still exactly equals agreement (recency fix does not blend freshness)", () => {
    const out = computeConfidenceMode2({
      slots: slotsCitingHypothesisEvidence(["e1"]),
      evidence: [
        { evidenceId: "e1", fetchedAt: NOW, sourcePublishedAt: new Date(NOW.getTime() - DECAY_CONSTANT_DAYS * MS_PER_DAY) },
      ],
      now: NOW,
    });
    expect(out.confidenceScore).toBe(out.agreement);
  });
});

describe("P3.2: compression lastEvidenceSeenAt recency", () => {
  it("all-present: lastEvidenceSeenAt = max(sourcePublishedAt), NOT max(fetchedAt)", () => {
    const later = new Date(NOW.getTime() - 1 * MS_PER_DAY);
    const earlyPub = new Date(NOW.getTime() - 30 * MS_PER_DAY);
    const midPub = new Date(NOW.getTime() - 10 * MS_PER_DAY);
    const res = computeMaxEvidenceRecency([
      { id: "e1", fetchedAt: later, sourcePublishedAt: earlyPub },
      { id: "e2", fetchedAt: later, sourcePublishedAt: midPub },
    ]);
    expect(res.lastEvidenceSeenAt?.toISOString()).toBe(midPub.toISOString());
    expect(res.maxUsedTimestamp).toBe("source_published_at");
    expect(res.sourcePublishedCount).toBe(2);
    expect(res.fetchedAtFallbackCount).toBe(0);
  });

  it("all-missing: lastEvidenceSeenAt = max(fetchedAt), fallback flagged in provenance", () => {
    const t1 = new Date(NOW.getTime() - 5 * MS_PER_DAY);
    const t2 = new Date(NOW.getTime() - 2 * MS_PER_DAY);
    const res = computeMaxEvidenceRecency([
      { id: "e1", fetchedAt: t1, sourcePublishedAt: null },
      { id: "e2", fetchedAt: t2, sourcePublishedAt: null },
    ]);
    expect(res.lastEvidenceSeenAt?.toISOString()).toBe(t2.toISOString());
    expect(res.maxUsedTimestamp).toBe("fetched_at_fallback");
    expect(res.sourcePublishedCount).toBe(0);
    expect(res.fetchedAtFallbackCount).toBe(2);
  });

  it("mixed: max recency picks winning chosen-value correctly, per-row provenance distinguishes rows", () => {
    const pubOlder = new Date(NOW.getTime() - 20 * MS_PER_DAY);
    const fetchedNewer = new Date(NOW.getTime() - 5 * MS_PER_DAY);
    const res = computeMaxEvidenceRecency([
      { id: "ePublished", fetchedAt: new Date(NOW.getTime() - 40 * MS_PER_DAY), sourcePublishedAt: pubOlder },
      { id: "eFallback", fetchedAt: fetchedNewer, sourcePublishedAt: null },
    ]);
    expect(res.lastEvidenceSeenAt?.toISOString()).toBe(fetchedNewer.toISOString());
    expect(res.maxUsedTimestamp).toBe("fetched_at_fallback");
    expect(res.sourcePublishedCount).toBe(1);
    expect(res.fetchedAtFallbackCount).toBe(1);
    const perRow = new Map(res.perRow.map((p) => [p.evidenceId, p.usedTimestamp]));
    expect(perRow.get("ePublished")).toBe("source_published_at");
    expect(perRow.get("eFallback")).toBe("fetched_at_fallback");
  });

  it("empty: lastEvidenceSeenAt is null, maxUsedTimestamp = 'empty'", () => {
    const res = computeMaxEvidenceRecency([]);
    expect(res.lastEvidenceSeenAt).toBeNull();
    expect(res.maxUsedTimestamp).toBe("empty");
    expect(res.sourcePublishedCount).toBe(0);
    expect(res.fetchedAtFallbackCount).toBe(0);
  });
});
