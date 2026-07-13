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
});
