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

// Returns a JSON string large enough that it would have been truncated at the
// previous max_tokens=4096 ceiling (~16KB of JSON ≈ 4096 tokens at 4 chars/token).
// Regression guard: if NimLLMClient's max_tokens ever regresses below 4096,
// a real live run with this volume of output would again produce truncated JSON.
class LargeOutputMockLLM implements LLMClient {
  static readonly MARKET_COUNT = 32;

  async complete(): Promise<string> {
    const STAGES = ["emerging", "growing", "mature", "declining"] as const;
    const markets = Array.from({ length: LargeOutputMockLLM.MARKET_COUNT }, (_, i) => ({
      label: `Market ${i + 1}: specialized vertical SaaS tooling for subscription commerce, recurring-revenue optimization, and involuntary-churn recovery in direct-to-consumer e-commerce ecosystems — segment ${i + 1}`,
      market_size_estimate: i % 3 === 0 ? 400_000_000 + i * 15_000_000 : null,
      growth_rate_estimate: i % 4 === 0 ? parseFloat((0.12 + i * 0.008).toFixed(3)) : null,
      maturity_stage: STAGES[i % 4],
      category_tags: [
        "subscription-commerce",
        `recurring-revenue-segment-${i + 1}`,
        "payment-failure-recovery",
        "involuntary-churn-tooling",
        "merchant-retention",
        "dunning-automation",
        `vertical-${i % 5}`,
      ],
      confidence: parseFloat((0.45 + (i % 6) * 0.09).toFixed(2)),
      evidence_refs: ["doc-001", "doc-002", "doc-003"].slice(0, (i % 3) + 1),
    }));
    return JSON.stringify({ markets });
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

  it("large output: parses and validates a response that would have been truncated at max_tokens=4096", async () => {
    const result = await runDiscoverySandbox(new LargeOutputMockLLM(), discoveryInputDocs);
    // Confirm the response is genuinely large (>16KB ≈ 4096 tokens at 4 chars/token)
    // so this test fails if the fixture shrinks below the regression threshold.
    expect(result.rawResponse.length).toBeGreaterThan(16_000);
    expect(result.parsed).not.toBeNull();
    expect(result.validationErrors.length).toBe(0);
    expect(result.parsed?.markets.length).toBe(LargeOutputMockLLM.MARKET_COUNT);
    // All markets should have valid evidence_refs (drawn from discoveryInputDocs ids)
    expect(result.boundedRuleViolations.length).toBe(0);
  });
});
