import { describe, it, expect } from "vitest";
import { runDiscoverySandbox } from "../discoverySandbox";
import { discoveryInputDocs } from "../__fixtures__/discovery-input-docs";
import type { LLMClient } from "../llmClient";

class GoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      markets: [
        {
          label: "Shopify subscription & recurring-order apps",
          market_size_estimate: null,
          growth_rate_estimate: null,
          maturity_stage: "mature",
          category_tags: ["subscriptions", "recurring-orders", "shopify-apps"],
          confidence: 0.7,
          evidence_refs: ["doc-001", "doc-002"],
        },
        {
          label: "Involuntary-churn / payment-recovery tooling for subscription commerce",
          market_size_estimate: null,
          growth_rate_estimate: null,
          maturity_stage: "emerging",
          category_tags: ["churn-recovery", "dunning", "payment-failure"],
          confidence: 0.55,
          evidence_refs: ["doc-003"],
        },
      ],
    });
  }
}

class BadMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      markets: [
        {
          label: "Shopify subscription apps",
          market_size_estimate: 450000000,
          growth_rate_estimate: 0.22,
          maturity_stage: "growing",
          category_tags: ["subscriptions"],
          confidence: 0.9,
          evidence_refs: ["doc-999"],
        },
      ],
    });
  }
}

class MalformedLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({ markets: [{ label: "no evidence_refs at all" }] });
  }
}

describe("discoverySandbox", () => {
  it("good response: parses, no validation errors, no bounded-rule violations, extracts 2 markets", async () => {
    const good = await runDiscoverySandbox(new GoodMockLLM(), discoveryInputDocs);
    expect(good.parsed).not.toBeNull();
    expect(good.validationErrors.length).toBe(0);
    expect(good.boundedRuleViolations.length).toBe(0);
    expect(good.parsed?.markets.length).toBe(2);
  });

  it("bad response: parses (schema-valid) but hallucinated citation is caught", async () => {
    const bad = await runDiscoverySandbox(new BadMockLLM(), discoveryInputDocs);
    expect(bad.parsed).not.toBeNull();
    expect(bad.boundedRuleViolations.some((v) => v.includes("hallucinated citation"))).toBe(true);
  });

  it("malformed response: fails to parse, produces a validation error", async () => {
    const malformed = await runDiscoverySandbox(new MalformedLLM(), discoveryInputDocs);
    expect(malformed.parsed).toBeNull();
    expect(malformed.validationErrors.length).toBeGreaterThan(0);
  });
});
