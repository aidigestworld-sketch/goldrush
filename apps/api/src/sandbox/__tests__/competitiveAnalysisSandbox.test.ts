import { describe, it, expect } from "vitest";
import { runCompetitiveAnalysisSandbox } from "../competitiveAnalysisSandbox";
import { competitiveAnalysisInputDocs } from "../__fixtures__/competitive-analysis-input-docs";
import type { LLMClient } from "../llmClient";

class GoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      existing_solutions: [
        {
          label: "Recharge",
          positioning_summary: "Built for growing and enterprise subscription brands, with dunning and payment-recovery tooling included at every tier.",
          positioning_summary_quote: "built for growing and enterprise subscription brands",
          positioning_summary_is_competitor_stated: true,
          pricing_summary: "$25-$499+/month tiers plus 1.0-1.49% and $0.19 per order",
          pricing_summary_quote: "1.0-1.49% and $0.19 per order",
          strengths: ["dunning and payment-recovery tooling included at every tier"],
          weaknesses: [],
          estimated_market_share: null,
          evidence_refs: ["doc-301"],
        },
        {
          label: "Bold Subscriptions",
          positioning_summary: "An analyst comparison piece characterizes Bold as reliable but less innovative — third-party commentary, not Bold's own marketing language.",
          positioning_summary_quote: "reliable but\nless innovative",
          positioning_summary_is_competitor_stated: false,
          pricing_summary: "Flat $49.99/month plus 1% transaction fee, no tiered pricing",
          pricing_summary_quote: "flat $49.99/month plus\na 1% transaction fee",
          strengths: [],
          weaknesses: [],
          estimated_market_share: null,
          evidence_refs: ["doc-303"],
        },
      ],
      business_models: [
        { competitor_label: "Recharge", model_type: "tiered_subscription_plus_percent_plus_per_order", model_type_quote: "1.0-1.49% and $0.19 per order", evidence_refs: ["doc-301"] },
        { competitor_label: "Bold Subscriptions", model_type: "flat_fee_plus_percent", model_type_quote: "flat $49.99/month plus\na 1% transaction fee", evidence_refs: ["doc-303"] },
      ],
    });
  }
}

class StereotypeMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      existing_solutions: [
        {
          label: "Recharge",
          positioning_summary: "Offers a 14-day free trial, typical of enterprise subscription SaaS tools.",
          positioning_summary_quote: "14-day free trial",
          positioning_summary_is_competitor_stated: true,
          pricing_summary: "$25-$499+/month tiers plus 1.0-1.49% and $0.19 per order",
          pricing_summary_quote: "1.0-1.49% and $0.19 per order",
          strengths: [],
          weaknesses: [],
          estimated_market_share: 0.35,
          evidence_refs: ["doc-301"],
        },
      ],
      business_models: [
        { competitor_label: "Recharge", model_type: "tiered_subscription", model_type_quote: "1.0-1.49% and $0.19 per order", evidence_refs: ["doc-301"] },
      ],
    });
  }
}

describe("competitiveAnalysisSandbox", () => {
  it("good response: parses, no validation errors, grounded quotes pass, Bold's analyst commentary flagged as non-competitor-stated", async () => {
    const good = await runCompetitiveAnalysisSandbox(new GoodMockLLM(), competitiveAnalysisInputDocs);
    expect(good.parsed).not.toBeNull();
    expect(good.validationErrors.length).toBe(0);
    expect(good.boundedRuleViolations.length).toBe(0);
    expect(good.sourceAttributionWarnings.some((w) => w.includes("Bold Subscriptions"))).toBe(true);
  });

  it("stereotype response: parses but invented free-trial claim caught as category-stereotype violation", async () => {
    const stereotype = await runCompetitiveAnalysisSandbox(new StereotypeMockLLM(), competitiveAnalysisInputDocs);
    expect(stereotype.parsed).not.toBeNull();
    expect(stereotype.boundedRuleViolations.some((v) => v.includes("14-day free trial") && v.includes("category-stereotype"))).toBe(true);
  });
});
