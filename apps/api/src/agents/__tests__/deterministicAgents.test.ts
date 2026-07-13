import { describe, it, expect } from "vitest";
import { applyFiltering } from "../filtering";
import { composeCandidate } from "../composition";
import { computeOpportunityQuality } from "../scoring";
import { runCompression } from "../compression";
import {
  computeConfidenceMode2,
  DECAY_CONSTANT_DAYS,
  type CompositionSlot,
  type ConfidenceMode2Input,
  type CompositionRole,
  COMPOSITION_ROLES,
} from "../confidenceMode2";
import auditFixture from "../../scripts/output/confidence_mode2_audit_data.json";

// ── Audit fixture types and helpers ──────────────────────────────────────────

interface FixtureCandidate {
  candidate_id: string;
  hypothesis_id: string | null;
  opportunity_quality: number | null;
  founder_fit_score: number | null;
  composition_rows: {
    field_name: string;
    value: string | null;
    is_null: boolean;
    source_refs: { evidence_id: string; evidence_polarity: string }[];
  }[];
  linked_evidence: {
    evidence_id: string;
    source_type: string;
    evidence_polarity: string;
    timestamp: string;
    text_excerpt: string;
    source_ref: string;
    node_id: string;
    node_type: string;
  }[];
}

const FIXED_NOW = new Date("2026-07-07T16:10:00Z");

function fixtureToInput(c: FixtureCandidate): ConfidenceMode2Input {
  const slots: CompositionSlot[] = COMPOSITION_ROLES.map<CompositionSlot>((role) => {
    const row = c.composition_rows.find((r) => r.field_name === role);
    if (!row) return { role, isNull: true, sourceRefs: [] };
    return {
      role,
      isNull: row.is_null,
      sourceRefs: row.source_refs.map((r) => ({
        evidenceId: r.evidence_id,
        evidencePolarity: r.evidence_polarity as "supporting" | "contradicting",
      })),
    };
  });
  const seen = new Map<string, Date>();
  for (const e of c.linked_evidence) {
    if (!seen.has(e.evidence_id)) seen.set(e.evidence_id, new Date(e.timestamp));
  }
  const evidence = [...seen].map(([evidenceId, fetchedAt]) => ({ evidenceId, fetchedAt, sourcePublishedAt: null }));
  return { slots, evidence, now: FIXED_NOW };
}

const EXPECTED = {
  "089dc429-9e94-4f3b-a8b9-cffd49ca06ce": { hypS: 21, hypC: 2, agreement: 21 / 23 },
  "95271656-9931-42c2-9805-f0d0682ff996": { hypS: 17, hypC: 1, agreement: 17 / 18 },
  "54535c9a-c667-47d5-a7e1-40ff3839a22a": { hypS: 17, hypC: 0, agreement: 1.0 },
  "fab5d955-b1b7-4d5c-9b61-8ab25e76c53b": { hypS: 16, hypC: 1, agreement: 16 / 17 },
};

const fixtures = auditFixture as FixtureCandidate[];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Filtering Agent", () => {
  it("filters by confidence threshold with correct deprecation reasons", () => {
    const results = applyFiltering(
      [
        { id: "a", confidence: 0.8 },
        { id: "b", confidence: 0.2 },
        { id: "c", confidence: null },
      ],
      { minConfidence: 0.3 }
    );
    expect(results.find((r) => r.id === "a")?.survived).toBe(true);
    expect(results.find((r) => r.id === "b")?.deprecationReason).toBe("below_confidence_threshold");
    expect(results.find((r) => r.id === "c")?.deprecationReason).toBe("missing_confidence");
  });
});

describe("Composition Agent", () => {
  it("complete active chain composes successfully with 5 role rows", () => {
    const complete = composeCandidate({
      market: { id: "m1", status: "active" },
      audience: { id: "a1", status: "active" },
      problem: { id: "p1", status: "active" },
      hypothesis: { id: "h1", status: "active" },
      businessModel: { id: "b1", status: "active" },
    });
    expect(complete.success).toBe(true);
    expect(complete.composition?.length).toBe(5);
  });

  it("incomplete chain: missing audience and inactive business_model are both flagged", () => {
    const incomplete = composeCandidate({
      market: { id: "m1", status: "active" },
      audience: null,
      problem: { id: "p1", status: "active" },
      hypothesis: { id: "h1", status: "active" },
      businessModel: { id: "b1", status: "deprecated" },
    });
    expect(incomplete.success).toBe(false);
    expect(incomplete.missingOrInactiveRoles.includes("audience")).toBe(true);
    expect(incomplete.missingOrInactiveRoles.includes("business_model")).toBe(true);
  });
});

describe("Scoring Agent", () => {
  it("all-populated inputs: sub-scores and final opportunity_quality match hand calculation", () => {
    const result = computeOpportunityQuality(
      {
        market: { growthRateEstimate: 0.2, maturityStage: "growing" },
        audience: { willingnessToPaySignal: 0.6, acquisitionChannelsKnown: ["seo", "paid_social", "email"] },
        problem: { severitySignal: 0.7, frequencySignal: 0.5 },
        hypothesis: { validationScore: 0.8, supportingEvidenceStrength: 0.7 },
        businessModel: { marginProfile: 0.65, operationalComplexityEstimate: 0.3, capitalIntensityEstimate: 0.2 },
      },
      { w1Demand: 0.2, w2Hypothesis: 0.2, w3Margin: 0.15, w4Feasibility: 0.15, w5Distribution: 0.15, w6Timing: 0.15 }
    );
    expect(Math.abs(result.subScores.demand - 0.6125)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(result.subScores.margin - 0.65)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(result.subScores.feasibility - 0.75)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(result.subScores.distribution - 1.0)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(result.subScores.timing - 0.75)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(result.opportunityQuality - 0.745)).toBeLessThanOrEqual(0.005);
  });

  it("P1.1/P2.1: 5 chronic-null fields default to neutral 0.5, defaultedInputCount = 5", () => {
    const withNulls = computeOpportunityQuality(
      {
        market: { growthRateEstimate: null, maturityStage: "emerging" },
        audience: { willingnessToPaySignal: null, acquisitionChannelsKnown: [] },
        problem: { severitySignal: null, frequencySignal: null },
        hypothesis: { validationScore: 0.5, supportingEvidenceStrength: 0.5 },
        businessModel: { marginProfile: null, operationalComplexityEstimate: null, capitalIntensityEstimate: null },
      },
      { w1Demand: 0.2, w2Hypothesis: 0.2, w3Margin: 0.15, w4Feasibility: 0.15, w5Distribution: 0.15, w6Timing: 0.15 }
    );
    expect(Math.abs(withNulls.subScores.margin - 0.5)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(withNulls.subScores.feasibility - 0.5)).toBeLessThanOrEqual(0.001);
    expect(withNulls.defaultedInputCount).toBe(5);
  });
});

describe("Compression Agent", () => {
  it("higher venture_score wins outright when margin exceeds threshold", () => {
    const result = runCompression(
      [
        { id: "cand-X", opportunityQuality: 0.8, founderFitScore: 70, confidenceScore: 0.7, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date("2026-06-01"), operationalComplexityEstimate: 0.3 },
        { id: "cand-Y", opportunityQuality: 0.5, founderFitScore: 50, confidenceScore: 0.7, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date("2026-06-01"), operationalComplexityEstimate: 0.3 },
      ],
      { minFounderFitThreshold: 25, qualityWeight: 0.7, founderFitWeight: 0.3 }
    );
    expect(result.winnerId).toBe("cand-X");
    expect(result.outcome).toBe("promoted");
  });

  it("identical venture_score resolved by higher confidence_score", () => {
    const result = runCompression(
      [
        { id: "cand-A", opportunityQuality: 0.7, founderFitScore: 70, confidenceScore: 0.9, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date("2026-06-01"), operationalComplexityEstimate: 0.3 },
        { id: "cand-B", opportunityQuality: 0.7, founderFitScore: 70, confidenceScore: 0.6, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date("2026-06-01"), operationalComplexityEstimate: 0.3 },
      ],
      { minFounderFitThreshold: 25, qualityWeight: 0.7, founderFitWeight: 0.3 }
    );
    expect(result.winnerId).toBe("cand-A");
  });

  it("identical-everything tie falls back to lowest candidate id", () => {
    const result = runCompression(
      [
        { id: "cand-Z9", opportunityQuality: 0.7, founderFitScore: 70, confidenceScore: 0.8, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date("2026-06-01"), operationalComplexityEstimate: 0.3 },
        { id: "cand-A1", opportunityQuality: 0.7, founderFitScore: 70, confidenceScore: 0.8, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date("2026-06-01"), operationalComplexityEstimate: 0.3 },
      ],
      { minFounderFitThreshold: 25, qualityWeight: 0.7, founderFitWeight: 0.3 }
    );
    expect(result.winnerId).toBe("cand-A1");
  });

  it("candidate below fit-gate excluded even with higher raw quality", () => {
    const result = runCompression(
      [
        { id: "cand-lowfit", opportunityQuality: 0.9, founderFitScore: 10, confidenceScore: 0.9, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date(), operationalComplexityEstimate: 0.2 },
        { id: "cand-passesgate", opportunityQuality: 0.5, founderFitScore: 30, confidenceScore: 0.5, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date(), operationalComplexityEstimate: 0.5 },
      ],
      { minFounderFitThreshold: 25, qualityWeight: 0.7, founderFitWeight: 0.3 }
    );
    expect(result.winnerId).toBe("cand-passesgate");
    expect(result.deprecated.find((d) => d.id === "cand-lowfit")?.reason).toBe("failed_gate");
  });

  it("no winner when every candidate fails the gate", () => {
    const result = runCompression(
      [{ id: "cand-only", opportunityQuality: 0.9, founderFitScore: 5, confidenceScore: 0.9, distributionSubScore: 0.5, lastEvidenceSeenAt: new Date(), operationalComplexityEstimate: 0.2 }],
      { minFounderFitThreshold: 25, qualityWeight: 0.7, founderFitWeight: 0.3 }
    );
    expect(result.winnerId).toBeNull();
    expect(result.outcome).toBe("insufficient_evidence");
  });
});

describe("Confidence Agent (Mode 2 — deterministic, revised)", () => {
  it("coverage gate passes: coverageGate=1, agreement/freshness null when no evidence", () => {
    const out = computeConfidenceMode2({
      slots: COMPOSITION_ROLES.map<CompositionSlot>((role) => ({ role, isNull: false, sourceRefs: [] })),
      evidence: [],
      now: new Date("2026-07-07T16:00:00Z"),
    });
    expect(out.coverageGate).toBe(1);
    expect(out.incompleteComposition).toBe(false);
    expect(out.agreement).toBeNull();
    expect(out.freshness).toBeNull();
    expect(out.confidenceScore).toBeNull();
    expect(out.slotEvidenceCounts.length).toBe(5);
  });

  it("coverage gate FAILS: one is_null slot → short-circuit, all downstream fields null", () => {
    const out = computeConfidenceMode2({
      slots: [
        { role: "market", isNull: false, sourceRefs: [] },
        { role: "audience", isNull: true, sourceRefs: [] },
        { role: "problem", isNull: false, sourceRefs: [] },
        { role: "hypothesis", isNull: false, sourceRefs: [{ evidenceId: "e1", evidencePolarity: "supporting" }, { evidenceId: "e2", evidencePolarity: "supporting" }] },
        { role: "business_model", isNull: false, sourceRefs: [] },
      ],
      evidence: [
        { evidenceId: "e1", fetchedAt: new Date("2026-07-07T16:00:00Z"), sourcePublishedAt: null },
        { evidenceId: "e2", fetchedAt: new Date("2026-07-07T16:00:00Z"), sourcePublishedAt: null },
      ],
      now: new Date("2026-07-07T16:00:00Z"),
    });
    expect(out.coverageGate).toBe(0);
    expect(out.incompleteComposition).toBe(true);
    expect(out.agreement).toBeNull();
    expect(out.freshness).toBeNull();
    expect(out.confidenceScore).toBeNull();
    expect(out.slotEvidenceCounts.length).toBe(5);
  });

  it("agreement uses only hypothesis-slot polarity split, other-slot refs ignored", () => {
    const out = computeConfidenceMode2({
      slots: [
        { role: "market", isNull: false, sourceRefs: [{ evidenceId: "e1", evidencePolarity: "contradicting" }] },
        { role: "audience", isNull: false, sourceRefs: [{ evidenceId: "e2", evidencePolarity: "supporting" }] },
        { role: "problem", isNull: false, sourceRefs: [{ evidenceId: "e3", evidencePolarity: "supporting" }] },
        { role: "hypothesis", isNull: false, sourceRefs: [
          { evidenceId: "e4", evidencePolarity: "supporting" },
          { evidenceId: "e5", evidencePolarity: "supporting" },
          { evidenceId: "e6", evidencePolarity: "supporting" },
          { evidenceId: "e7", evidencePolarity: "contradicting" },
        ] },
        { role: "business_model", isNull: false, sourceRefs: [{ evidenceId: "e8", evidencePolarity: "supporting" }] },
      ],
      evidence: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        evidenceId: `e${i}`,
        fetchedAt: new Date("2026-07-07T16:00:00Z"),
        sourcePublishedAt: null,
      })),
      now: new Date("2026-07-07T16:00:00Z"),
    });
    expect(Math.abs((out.agreement ?? -1) - 0.75)).toBeLessThanOrEqual(0.0001);
    expect(Math.abs((out.confidenceScore ?? -1) - 0.75)).toBeLessThanOrEqual(0.0001);
    const marketCounts = out.slotEvidenceCounts.find((s) => s.role === "market")!;
    expect(marketCounts.distinctSupportingCount).toBe(0);
    expect(marketCounts.distinctContradictingCount).toBe(1);
  });

  it("freshness half-life: single evidence DECAY_CONSTANT_DAYS old scores 0.5", () => {
    const out = computeConfidenceMode2({
      slots: COMPOSITION_ROLES.map<CompositionSlot>((role) => ({
        role,
        isNull: false,
        sourceRefs: role === "hypothesis" ? [{ evidenceId: "eOld", evidencePolarity: "supporting" }] : [],
      })),
      evidence: [
        { evidenceId: "eOld", fetchedAt: new Date(Date.UTC(2026, 6, 7, 16, 0, 0) - DECAY_CONSTANT_DAYS * 86400_000), sourcePublishedAt: null },
      ],
      now: new Date("2026-07-07T16:00:00Z"),
    });
    expect(Math.abs((out.freshness ?? -1) - 0.5)).toBeLessThanOrEqual(0.0001);
    expect(Math.abs((out.agreement ?? -1) - 1.0)).toBeLessThanOrEqual(0.0001);
    expect(Math.abs((out.confidenceScore ?? -1) - 1.0)).toBeLessThanOrEqual(0.0001);
  });

  it("future-dated evidence clamps to freshness 1.0, not >1", () => {
    const out = computeConfidenceMode2({
      slots: COMPOSITION_ROLES.map<CompositionSlot>((role) => ({
        role,
        isNull: false,
        sourceRefs: role === "hypothesis" ? [{ evidenceId: "eFuture", evidencePolarity: "supporting" }] : [],
      })),
      evidence: [
        { evidenceId: "eFuture", fetchedAt: new Date(Date.UTC(2026, 6, 7, 16, 0, 0) + 30 * 86400_000), sourcePublishedAt: null },
      ],
      now: new Date("2026-07-07T16:00:00Z"),
    });
    expect(Math.abs((out.freshness ?? -1) - 1.0)).toBeLessThanOrEqual(0.0001);
  });

  it("audit fixtures: all 4 real candidates match expected hypothesis S/C ratios and agreement", () => {
    expect(fixtures.length).toBe(4);
    for (const c of fixtures) {
      const out = computeConfidenceMode2(fixtureToInput(c));
      const label = `candidate ${c.candidate_id.substring(0, 8)}`;
      const expected = EXPECTED[c.candidate_id as keyof typeof EXPECTED];
      expect(out.coverageGate).toBe(1);
      expect(out.incompleteComposition).toBe(false);
      const hypCounts = out.slotEvidenceCounts.find((s) => s.role === "hypothesis")!;
      expect(hypCounts.distinctSupportingCount).toBe(expected.hypS);
      expect(hypCounts.distinctContradictingCount).toBe(expected.hypC);
      expect(Math.abs((out.agreement ?? -1) - expected.agreement)).toBeLessThanOrEqual(0.0001);
      expect(Math.abs((out.confidenceScore ?? -1) - expected.agreement)).toBeLessThanOrEqual(0.0001);
      const fr = out.freshness;
      expect(fr !== null && fr >= 0 && fr <= 1).toBe(true);
      expect(fr !== null && fr > 0.95).toBe(true);
    }
  });

  it("audit fixtures: revised formula produces real separation between candidates (spread > 0.05)", () => {
    const scores = fixtures.map((c) => computeConfidenceMode2(fixtureToInput(c)).confidenceScore!);
    const scoreSpread = Math.max(...scores) - Math.min(...scores);
    expect(scoreSpread > 0.05).toBe(true);
  });
});
