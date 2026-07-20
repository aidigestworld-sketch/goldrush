import { describe, it, expect } from "vitest";
import {
  runOpportunityRationaleSandbox,
  type OpportunityRationaleInput,
} from "../opportunityRationaleSandbox";
import type { LLMClient } from "../llmClient";

class MockLLM implements LLMClient {
  readonly model = "mock";
  constructor(private readonly response: string) {}
  async complete(): Promise<string> {
    return this.response;
  }
}

function baseInput(): OpportunityRationaleInput {
  return {
    candidate: {
      id: "cand-1",
      opportunityQuality: 0.55,
      confidenceScore: 0.9,
      founderFitScore: 60,
      ventureScore: 0.55,
      founderFitRationale: "The founder has strong Shopify expertise. Would need to compete against Recharge's fee model.",
    },
    composition: [
      {
        role: "market",
        node: { label: "Shopify subs", growth_rate_estimate: 0.4, market_size_estimate: 1e9, maturity_stage: "growing", confidence: 0.8 },
      },
      {
        role: "problem",
        node: { label: "Involuntary churn", severity_signal: 0.85, frequency_signal: 0.7, problem_maturity: "widely_reported", confidence: 0.9 },
      },
      {
        role: "hypothesis",
        node: { statement: "Merchants lose subs to card expiry", validation_score: 0.75, supporting_evidence_strength: 0.7, confidence: 0.85 },
      },
    ],
    evidence: [
      { id: "0aee3433-d97b-426e-ad80-ee5aee7e6288", sourceType: "review_complaint", extractedFact: "Card update flow is broken.", polarity: "supporting" },
      { id: "1bff5544-e8ac-537f-be91-ff6bff8f7399", sourceType: "industry_report", extractedFact: "5% monthly churn is typical.", polarity: "supporting" },
    ],
    signals: {
      contradictingEvidenceCount: 0,
      nullCompositionFields: ["audience.willingness_to_pay_signal"],
      founderFitGaps: ["Would need to compete against Recharge's fee model"],
    },
  };
}

describe("opportunityRationaleSandbox", () => {
  it("grounded response: parses, no grounding violations", async () => {
    const goodResponse = JSON.stringify({
      rationale_bullets: [
        { text: "Market growth rate 0.4 reflects a growing subscriptions category.", source_ref: "composition:market:growth_rate_estimate" },
        { text: "Severity signal 0.85 indicates a genuinely painful problem.", source_ref: "composition:problem:severity_signal" },
        { text: "Card update flow is broken, per a real merchant review.", source_ref: "evidence:0aee3433-d97b-426e-ad80-ee5aee7e6288" },
      ],
      risk_summary: [
        { text: "Hypothesis validation_score 0.75 depends on limited evidence.", source_ref: "composition:hypothesis:validation_score" },
        { text: "Problem severity 0.85 is high but confidence is 0.9 — narrow error bar.", source_ref: "composition:problem:severity_signal" },
      ],
    });
    const result = await runOpportunityRationaleSandbox(new MockLLM(goodResponse), baseInput());
    expect(result.parsed).not.toBeNull();
    expect(result.groundingViolations.length).toBe(0);
  });

  it("invented evidence id: parses schema but invented id is flagged as grounding violation", async () => {
    const badResponse = JSON.stringify({
      rationale_bullets: [
        { text: "Growth rate is decent overall.", source_ref: "composition:market:growth_rate_estimate" },
        { text: "This other paper says 30% CAGR is typical for the space.", source_ref: "evidence:99999999-9999-9999-9999-999999999999" },
        { text: "Third bullet fine here for length.", source_ref: "composition:problem:severity_signal" },
      ],
      risk_summary: [
        { text: "Growth rate 0.4 is not established.", source_ref: "composition:market:growth_rate_estimate" },
        { text: "Severity signal 0.85 could weaken.", source_ref: "composition:problem:severity_signal" },
      ],
    });
    const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
    expect(result.parsed).not.toBeNull();
    expect(result.groundingViolations.some((v) => v.includes("99999999"))).toBe(true);
  });

  it("invented composition field: flagged as grounding violation", async () => {
    const badResponse = JSON.stringify({
      rationale_bullets: [
        { text: "Growth rate is decent overall.", source_ref: "composition:market:this_field_is_made_up" },
        { text: "Severity signal is 0.85 as recorded.", source_ref: "composition:problem:severity_signal" },
        { text: "Validation score 0.75 is above the gate.", source_ref: "composition:hypothesis:validation_score" },
      ],
      risk_summary: [
        { text: "Growth rate 0.4 is not established.", source_ref: "composition:market:growth_rate_estimate" },
        { text: "Severity signal 0.85 could weaken.", source_ref: "composition:problem:severity_signal" },
      ],
    });
    const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
    expect(result.groundingViolations.some((v) => v.includes("this_field_is_made_up"))).toBe(true);
  });

  it("invented (absent) role: flagged as grounding violation", async () => {
    const badResponse = JSON.stringify({
      rationale_bullets: [
        { text: "The audience willingness-to-pay is 0.9.", source_ref: "composition:audience:willingness_to_pay_signal" },
        { text: "Growth rate is 0.4 per year.", source_ref: "composition:market:growth_rate_estimate" },
        { text: "Severity signal is 0.85.", source_ref: "composition:problem:severity_signal" },
      ],
      risk_summary: [
        { text: "Growth rate 0.4 is not established.", source_ref: "composition:market:growth_rate_estimate" },
        { text: "Severity signal 0.85 could weaken.", source_ref: "composition:problem:severity_signal" },
      ],
    });
    const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
    expect(result.groundingViolations.some((v) => v.includes("audience"))).toBe(true);
  });

  it("under-min bullets fails schema, validation errors reported", async () => {
    const badResponse = JSON.stringify({
      rationale_bullets: [{ text: "only-one-bullet", source_ref: "composition:market:label" }],
      risk_summary: [{ text: "r", source_ref: "x" }],
    });
    const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
    expect(result.parsed).toBeNull();
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  // ── candidate:<field> shape (new) ──────────────────────────────────

  describe("candidate:<field> citation shape", () => {
    it("valid candidate:founder_fit_score passes grounding", async () => {
      const goodResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Founder-fit score 60/100 clears the promotion gate.", source_ref: "candidate:founder_fit_score" },
          { text: "Growth rate 0.4 reflects a growing category.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity signal 0.85 indicates real pain.", source_ref: "composition:problem:severity_signal" },
        ],
        risk_summary: [
          { text: "Founder-fit rationale identifies Recharge as a competitor.", source_ref: "candidate:founder_fit_rationale" },
          { text: "Validation score 0.75 depends on limited evidence.", source_ref: "composition:hypothesis:validation_score" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(goodResponse), baseInput());
      expect(result.parsed).not.toBeNull();
      expect(result.groundingViolations).toEqual([]);
    });

    it("invented candidate field (e.g. venture_score) is flagged as grounding violation", async () => {
      const badResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Venture score 0.55 is above the promotion floor.", source_ref: "candidate:venture_score" },
          { text: "Growth rate 0.4 reflects a growing category.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity signal 0.85 indicates real pain.", source_ref: "composition:problem:severity_signal" },
        ],
        risk_summary: [
          { text: "Validation score 0.75 is limited.", source_ref: "composition:hypothesis:validation_score" },
          { text: "Severity 0.85 could weaken.", source_ref: "composition:problem:severity_signal" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
      expect(result.groundingViolations.some((v) => v.includes("candidate:venture_score"))).toBe(true);
    });

    it("malformed candidate: (missing field) is flagged", async () => {
      const badResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Some candidate-scoped claim.", source_ref: "candidate:" },
          { text: "Growth rate 0.4.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity 0.85.", source_ref: "composition:problem:severity_signal" },
        ],
        risk_summary: [
          { text: "Validation score 0.75.", source_ref: "composition:hypothesis:validation_score" },
          { text: "Severity 0.85 could weaken.", source_ref: "composition:problem:severity_signal" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
      expect(result.groundingViolations.some((v) => v.includes("candidate:") && v.includes("malformed"))).toBe(true);
    });
  });

  // ── signals:<name>[<index>] shape (new) ────────────────────────────

  describe("signals:<name>[<index>] citation shape", () => {
    it("valid signals:founder_fit_gaps[0] + signals:null_composition_fields[0] pass grounding", async () => {
      // baseInput() has 1 entry in each of founderFitGaps + nullCompositionFields.
      const goodResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Growth rate 0.4 reflects a growing category.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity signal 0.85 indicates real pain.", source_ref: "composition:problem:severity_signal" },
          { text: "Card update flow is broken.", source_ref: "evidence:0aee3433-d97b-426e-ad80-ee5aee7e6288" },
        ],
        risk_summary: [
          { text: "Founder would need to compete against Recharge's fee model.", source_ref: "signals:founder_fit_gaps[0]" },
          { text: "audience.willingness_to_pay_signal is null — pricing risk unresolved.", source_ref: "signals:null_composition_fields[0]" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(goodResponse), baseInput());
      expect(result.parsed).not.toBeNull();
      expect(result.groundingViolations).toEqual([]);
    });

    it("out-of-bounds index rejected — signals:founder_fit_gaps[5] when array length is 1", async () => {
      const badResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Growth rate 0.4.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity 0.85.", source_ref: "composition:problem:severity_signal" },
          { text: "Third bullet fine.", source_ref: "composition:hypothesis:validation_score" },
        ],
        risk_summary: [
          { text: "Some other gap that doesn't exist.", source_ref: "signals:founder_fit_gaps[5]" },
          { text: "Validation score 0.75.", source_ref: "composition:hypothesis:validation_score" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
      expect(result.groundingViolations.some((v) => v.includes("out of bounds") && v.includes("founder_fit_gaps"))).toBe(true);
    });

    it("unknown signal name rejected — signals:something_made_up[0]", async () => {
      const badResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Growth rate 0.4.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity 0.85.", source_ref: "composition:problem:severity_signal" },
          { text: "Third bullet fine.", source_ref: "composition:hypothesis:validation_score" },
        ],
        risk_summary: [
          { text: "Some invented signal.", source_ref: "signals:something_made_up[0]" },
          { text: "Validation score 0.75.", source_ref: "composition:hypothesis:validation_score" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
      expect(result.groundingViolations.some((v) => v.includes("something_made_up") && v.includes("not a citable"))).toBe(true);
    });

    it("malformed shape (missing index) rejected — signals:founder_fit_gaps without brackets", async () => {
      const badResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Growth rate 0.4.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity 0.85.", source_ref: "composition:problem:severity_signal" },
          { text: "Third bullet fine.", source_ref: "composition:hypothesis:validation_score" },
        ],
        risk_summary: [
          { text: "Gaps without any index.", source_ref: "signals:founder_fit_gaps" },
          { text: "Validation score 0.75.", source_ref: "composition:hypothesis:validation_score" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
      expect(result.groundingViolations.some((v) => v.includes("signals:founder_fit_gaps") && v.includes("malformed"))).toBe(true);
    });

    it("regression: previously-observed model output shape (missing signals: prefix) still rejected", async () => {
      // The specific bug from the 2026-07-20 backfill: model emitted
      // "founder_fit_gaps[0]" instead of "signals:founder_fit_gaps[0]".
      // Broadening the validator MUST NOT accidentally accept this
      // prefix-less shape — the fallback branch is what catches it.
      const badResponse = JSON.stringify({
        rationale_bullets: [
          { text: "Growth rate 0.4.", source_ref: "composition:market:growth_rate_estimate" },
          { text: "Severity 0.85.", source_ref: "composition:problem:severity_signal" },
          { text: "Third bullet fine.", source_ref: "composition:hypothesis:validation_score" },
        ],
        risk_summary: [
          { text: "Founder gap from the actual observed bug shape.", source_ref: "founder_fit_gaps[0]" },
          { text: "Validation score 0.75.", source_ref: "composition:hypothesis:validation_score" },
        ],
      });
      const result = await runOpportunityRationaleSandbox(new MockLLM(badResponse), baseInput());
      expect(
        result.groundingViolations.some((v) => v.includes("founder_fit_gaps[0]") && v.includes("must start with"))
      ).toBe(true);
    });
  });
});
