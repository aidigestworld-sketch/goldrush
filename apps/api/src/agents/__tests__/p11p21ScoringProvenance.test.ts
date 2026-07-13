import { describe, it, expect } from "vitest";
import { computeOpportunityQuality, type ScoringInputs, type ScoringConfigWeights } from "../scoring";

const WEIGHTS: ScoringConfigWeights = {
  w1Demand: 0.2,
  w2Hypothesis: 0.2,
  w3Margin: 0.15,
  w4Feasibility: 0.15,
  w5Distribution: 0.15,
  w6Timing: 0.15,
};

function baseInputs(): ScoringInputs {
  return {
    market: { growthRateEstimate: null, maturityStage: "growing" },
    audience: { willingnessToPaySignal: null, acquisitionChannelsKnown: ["seo"] },
    problem: { severitySignal: null, frequencySignal: null },
    hypothesis: { validationScore: 0.75, supportingEvidenceStrength: 0.8 },
    businessModel: {
      marginProfile: null,
      operationalComplexityEstimate: null,
      capitalIntensityEstimate: null,
    },
  };
}

describe("P1.1/P2.1: 5-field chronic-null provenance", () => {
  it("all-null: all 5 chronic-null fields flagged default, 2 hard-asserted fields real, counts correct", () => {
    const out = computeOpportunityQuality(baseInputs(), WEIGHTS);
    const bySource = new Map(out.scoringInputProvenance.map((p) => [p.field, p.source]));
    expect(bySource.get("growthRateEstimate")).toBe("default");
    expect(bySource.get("willingnessToPaySignal")).toBe("default");
    expect(bySource.get("validationScore")).toBe("real");
    expect(bySource.get("supportingEvidenceStrength")).toBe("real");
    expect(bySource.get("marginProfile")).toBe("default");
    expect(bySource.get("operationalComplexityEstimate")).toBe("default");
    expect(bySource.get("capitalIntensityEstimate")).toBe("default");
    expect(out.defaultedInputCount).toBe(5);
    expect(out.realInputCount).toBe(2);
    expect(out.scoringInputProvenance.length).toBe(7);
  });

  it("all-populated: no defaults, all 7 inputs real, values echo through unchanged", () => {
    const inputs = baseInputs();
    inputs.market.growthRateEstimate = 0.2;
    inputs.audience.willingnessToPaySignal = 0.6;
    inputs.businessModel.marginProfile = 0.65;
    inputs.businessModel.operationalComplexityEstimate = 0.3;
    inputs.businessModel.capitalIntensityEstimate = 0.2;
    const out = computeOpportunityQuality(inputs, WEIGHTS);
    expect(out.defaultedInputCount).toBe(0);
    expect(out.realInputCount).toBe(7);
    for (const p of out.scoringInputProvenance) {
      expect(p.source).toBe("real");
    }
    const byField = new Map(out.scoringInputProvenance.map((p) => [p.field, p.value]));
    expect(Math.abs((byField.get("growthRateEstimate") ?? -1) - 0.2)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs((byField.get("willingnessToPaySignal") ?? -1) - 0.6)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs((byField.get("marginProfile") ?? -1) - 0.65)).toBeLessThanOrEqual(1e-9);
  });

  it("mixed: 2 of 5 chronic-null populated, 3 null, per-field flags correctly distinguish them", () => {
    const inputs = baseInputs();
    inputs.market.growthRateEstimate = 0.15;
    inputs.businessModel.marginProfile = 0.5;
    const out = computeOpportunityQuality(inputs, WEIGHTS);
    const bySource = new Map(out.scoringInputProvenance.map((p) => [p.field, p.source]));
    expect(bySource.get("growthRateEstimate")).toBe("real");
    expect(bySource.get("marginProfile")).toBe("real");
    expect(bySource.get("willingnessToPaySignal")).toBe("default");
    expect(bySource.get("operationalComplexityEstimate")).toBe("default");
    expect(bySource.get("capitalIntensityEstimate")).toBe("default");
    expect(out.defaultedInputCount).toBe(3);
    expect(out.realInputCount).toBe(4);
  });
});

describe("P1.1/P2.1: byte-identical opportunityQuality (regression guard)", () => {
  it("all-null path: opportunity_quality and sub-scores match pre-fix hand calculation", () => {
    const out = computeOpportunityQuality(baseInputs(), WEIGHTS);
    expect(Math.abs(out.opportunityQuality - 0.5675)).toBeLessThanOrEqual(1e-4);
    expect(Math.abs(out.subScores.demand - 0.5)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(out.subScores.hypothesis - 0.775)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(out.subScores.margin - 0.5)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(out.subScores.feasibility - 0.5)).toBeLessThanOrEqual(1e-9);
  });

  it("reference fixture (deterministicAgents.test.ts:74): sub-scores byte-identical, no defaults fired", () => {
    const out = computeOpportunityQuality(
      {
        market: { growthRateEstimate: 0.2, maturityStage: "growing" },
        audience: { willingnessToPaySignal: 0.6, acquisitionChannelsKnown: ["seo", "paid_social", "email"] },
        problem: { severitySignal: 0.7, frequencySignal: 0.5 },
        hypothesis: { validationScore: 0.8, supportingEvidenceStrength: 0.7 },
        businessModel: { marginProfile: 0.65, operationalComplexityEstimate: 0.3, capitalIntensityEstimate: 0.2 },
      },
      WEIGHTS
    );
    expect(Math.abs(out.subScores.demand - 0.6125)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(out.subScores.margin - 0.65)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(out.subScores.feasibility - 0.75)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(out.subScores.distribution - 1.0)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(out.subScores.timing - 0.75)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(out.opportunityQuality - 0.745)).toBeLessThanOrEqual(5e-3);
    expect(out.defaultedInputCount).toBe(0);
  });
});

describe("P1.1/P2.1: hard assertion on the 2 structurally-non-null fields", () => {
  it("throws on null validationScore, message names Composition's gate and field", () => {
    const inputs = baseInputs();
    inputs.hypothesis.validationScore = null;
    let caughtError: Error | null = null;
    try { computeOpportunityQuality(inputs, WEIGHTS); } catch (err) { caughtError = err as Error; }
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("compositionAgent.ts:57");
    expect(caughtError!.message).toContain("validationScore");
    expect(caughtError!.message).toContain("Composition");
  });

  it("throws on null supportingEvidenceStrength, message names Hypothesis Agent's contract", () => {
    const inputs = baseInputs();
    inputs.hypothesis.supportingEvidenceStrength = null;
    let caughtError: Error | null = null;
    try { computeOpportunityQuality(inputs, WEIGHTS); } catch (err) { caughtError = err as Error; }
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("hypothesisAgent.ts");
    expect(caughtError!.message).toContain("supportingEvidenceStrength");
    expect(caughtError!.message).toContain("evidenceStrength.ts");
  });

  it("both null: validationScore's throw fires first (checked-order semantics)", () => {
    const inputs = baseInputs();
    inputs.hypothesis.validationScore = null;
    inputs.hypothesis.supportingEvidenceStrength = null;
    let caughtError: Error | null = null;
    try { computeOpportunityQuality(inputs, WEIGHTS); } catch (err) { caughtError = err as Error; }
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("validationScore");
  });

  it("normal candidate: no throw fires, output produced", () => {
    const inputs = baseInputs();
    inputs.hypothesis.validationScore = 0.85;
    inputs.hypothesis.supportingEvidenceStrength = 0.8;
    const out = computeOpportunityQuality(inputs, WEIGHTS);
    expect(typeof out.opportunityQuality).toBe("number");
  });
});
