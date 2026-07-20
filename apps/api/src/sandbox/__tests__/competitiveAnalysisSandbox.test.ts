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

class ProsePreambleMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return (
      "Here is the competitive analysis based on the provided documents:\n\n" +
      JSON.stringify({
        existing_solutions: [
          {
            label: "Recharge",
            positioning_summary: "Built for growing and enterprise subscription brands.",
            positioning_summary_quote: "built for growing and enterprise subscription brands",
            positioning_summary_is_competitor_stated: true,
            pricing_summary: null,
            pricing_summary_quote: null,
            strengths: ["dunning and payment-recovery tooling included at every tier"],
            weaknesses: [],
            estimated_market_share: null,
            evidence_refs: ["doc-301"],
          },
        ],
        business_models: [
          {
            competitor_label: "Recharge",
            model_type: "tiered_subscription_plus_percent_plus_per_order",
            model_type_quote: "1.0-1.49% and $0.19 per order",
            evidence_refs: ["doc-301"],
          },
        ],
      })
    );
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

  it("prose preamble before JSON: extractAndClean strips preamble and parses correctly", async () => {
    const result = await runCompetitiveAnalysisSandbox(new ProsePreambleMockLLM(), competitiveAnalysisInputDocs);
    expect(result.parsed).not.toBeNull();
    expect(result.validationErrors.length).toBe(0);
    expect(result.parsed?.existing_solutions.length).toBe(1);
    expect(result.boundedRuleViolations.length).toBe(0);
  });

  it("stereotype response: positioning_summary invented free-trial claim gets stripped (nulled) rather than raising BRV — mirrors Expansion's stripIfUngrounded pattern; pricing_summary grounds and stays", async () => {
    const stereotype = await runCompetitiveAnalysisSandbox(new StereotypeMockLLM(), competitiveAnalysisInputDocs);
    expect(stereotype.parsed).not.toBeNull();
    // No grounding BRV — paraphrased quote is silently nulled, not raised.
    // (Retrying wouldn't help; same LLM would paraphrase again.)
    expect(stereotype.boundedRuleViolations.some((v) => v.includes("14-day free trial"))).toBe(false);
    // Solution row still lands (label + strengths still useful downstream),
    // just with positioning stripped to null.
    const sol = stereotype.parsed?.existing_solutions[0];
    expect(sol?.label).toBe("Recharge");
    expect(sol?.positioning_summary).toBeNull();
    expect(sol?.positioning_summary_quote).toBeNull();
    // pricing_summary grounds in doc-301, stays intact.
    expect(sol?.pricing_summary).toContain("1.0-1.49%");
    expect(sol?.pricing_summary_quote).toContain("1.0-1.49%");
  });

  it("paraphrased pricing quote (live b2b run 2026-07-20 regression): ungrounded pricing_summary_quote is stripped, solution row still lands", async () => {
    class ParaphrasedPricingMockLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          existing_solutions: [
            {
              label: "Recharge",
              positioning_summary: "Built for growing and enterprise subscription brands.",
              positioning_summary_quote: "built for growing and enterprise subscription brands",
              positioning_summary_is_competitor_stated: true,
              // Paraphrased — actual doc has "1.0-1.49% and $0.19 per order"
              pricing_summary: "Plans run from $25 to $499+ per month, plus fees",
              pricing_summary_quote: "Plans range from $25/mo to $499+/mo, with transaction fees on top",
              strengths: ["dunning and payment-recovery tooling included at every tier"],
              weaknesses: [],
              estimated_market_share: null,
              evidence_refs: ["doc-301"],
            },
          ],
          business_models: [
            // Also paraphrased — dropped entirely (model_type_quote required).
            {
              competitor_label: "Recharge",
              model_type: "tiered subscription plus per-order fee",
              model_type_quote: "Recharge charges tiered subscriptions plus per-order fees",
              evidence_refs: ["doc-301"],
            },
          ],
        });
      }
    }
    const result = await runCompetitiveAnalysisSandbox(new ParaphrasedPricingMockLLM(), competitiveAnalysisInputDocs);
    expect(result.parsed).not.toBeNull();
    expect(result.boundedRuleViolations).toEqual([]);
    // Solution row kept, positioning stays (grounds), pricing stripped.
    expect(result.parsed?.existing_solutions.length).toBe(1);
    expect(result.parsed?.existing_solutions[0].positioning_summary).not.toBeNull();
    expect(result.parsed?.existing_solutions[0].pricing_summary).toBeNull();
    expect(result.parsed?.existing_solutions[0].pricing_summary_quote).toBeNull();
    // Business model with ungrounded model_type_quote dropped entirely
    // (can't null a required field; matches the same "don't let ungrounded
    // content land in DB" spirit).
    expect(result.parsed?.business_models.length).toBe(0);
  });

  // Regression: a live b2b_customer_support_saas run (2026-07-20) had CA's
  // LLM emit evidence_refs as "document <uuid>" — echoing the prompt's
  // `[document id="<uuid>"]` wrapper. checkRefs's exact-match failed
  // every ref, flagged every solution BRV, cascade zeroed out silently.
  // Sandbox now strips a leading "document " and rewrites parsed refs
  // in-place so downstream nodeSourceRefRepository.createMany also
  // receives clean ids.
  it("document-prefix response: 'document <valid-id>' refs are stripped, resolve to docs, no BRV, parsed refs are normalized in place", async () => {
    class DocumentPrefixMockLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          existing_solutions: [
            {
              label: "Recharge",
              positioning_summary: "Built for growing and enterprise subscription brands.",
              positioning_summary_quote: "built for growing and enterprise subscription brands",
              positioning_summary_is_competitor_stated: true,
              pricing_summary: null,
              pricing_summary_quote: null,
              strengths: [],
              weaknesses: [],
              estimated_market_share: null,
              evidence_refs: ["document doc-301"],
            },
          ],
          business_models: [
            {
              competitor_label: "Recharge",
              model_type: "tiered_subscription_plus_percent_plus_per_order",
              model_type_quote: "1.0-1.49% and $0.19 per order",
              evidence_refs: ["Document  doc-301"], // capitalization + extra whitespace on purpose
            },
          ],
        });
      }
    }
    const result = await runCompetitiveAnalysisSandbox(new DocumentPrefixMockLLM(), competitiveAnalysisInputDocs);
    expect(result.parsed).not.toBeNull();
    expect(result.boundedRuleViolations).toEqual([]);
    // Parsed refs are rewritten to bare ids so downstream write-path
    // receives already-clean values (no "document " prefix leaks into
    // node_source_refs.evidence_id).
    expect(result.parsed?.existing_solutions[0].evidence_refs).toEqual(["doc-301"]);
    expect(result.parsed?.business_models[0].evidence_refs).toEqual(["doc-301"]);
  });

  it("document-prefix response: a genuinely-nonexistent id STILL fails after prefix strip (not accepting anything malformed)", async () => {
    class DocumentPrefixFakeIdMockLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          existing_solutions: [
            {
              label: "Recharge",
              positioning_summary: "Built for growing and enterprise subscription brands.",
              positioning_summary_quote: "built for growing and enterprise subscription brands",
              positioning_summary_is_competitor_stated: true,
              pricing_summary: null,
              pricing_summary_quote: null,
              strengths: [],
              weaknesses: [],
              estimated_market_share: null,
              evidence_refs: ["document doc-999-fake"],
            },
          ],
          business_models: [],
        });
      }
    }
    const result = await runCompetitiveAnalysisSandbox(new DocumentPrefixFakeIdMockLLM(), competitiveAnalysisInputDocs);
    expect(result.parsed).not.toBeNull();
    expect(result.boundedRuleViolations.some((v) => v.includes("Recharge") && v.includes("nonexistent evidence_refs"))).toBe(true);
  });
});
