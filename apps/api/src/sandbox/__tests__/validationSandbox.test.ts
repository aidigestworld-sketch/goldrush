import { describe, it, expect } from "vitest";
import { runValidationSandbox } from "../validationSandbox";
import { validationInput } from "../__fixtures__/validation-input";
import type { LLMClient } from "../llmClient";

class GoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      classified_evidence: [
        {
          evidence_id: "candidate-loop-framing",
          classification: "inconclusive",
          note: "Loop does market a voluntary-vs-involuntary distinction, but their framing is specifically about payment-failure-driven churn (declined cards, insufficient funds), not the Shop-Pay-card-removal mechanism this hypothesis describes. Topically related, mechanism does not match — this is not a real contradiction of the specific gap.",
        },
        {
          evidence_id: "candidate-industry-distinction",
          classification: "supports",
          note: "Confirms the broader industry-recognized distinction between voluntary and involuntary churn requiring different tooling, reinforcing that this is a real, recognized category of gap, not a fabricated one.",
        },
        {
          evidence_id: "candidate-irrelevant-pricing",
          classification: "inconclusive",
          note: "This is pricing information only and does not address churn classification, retention mechanisms, or cancellation handling in any way relevant to the hypothesis.",
        },
      ],
      unresolved_questions: [
        "Whether Recharge, Loop, or Bold have any unmarketed internal capability to detect Shop-Pay-triggered cancellations specifically, as opposed to general payment-failure churn.",
      ],
      additional_search_queries_would_run: [
        "Recharge Shop Pay card removal cancellation detection",
        "Loop Subscriptions forced cancellation vs voluntary cancellation distinction",
      ],
    });
  }
}

class HallucinatedMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      classified_evidence: [
        {
          evidence_id: "nonexistent-candidate-id",
          classification: "contradicts",
          note: "This citation refers to evidence that was never actually provided in the input set.",
        },
      ],
      unresolved_questions: [],
      additional_search_queries_would_run: [],
    });
  }
}

describe("validationSandbox", () => {
  it("good response: parses, no validation errors, no bounded-rule violations, classifies all 3 candidates, mechanism-mismatched candidate is inconclusive not contradiction", async () => {
    const good = await runValidationSandbox(new GoodMockLLM(), validationInput);
    expect(good.parsed).not.toBeNull();
    expect(good.validationErrors.length).toBe(0);
    expect(good.boundedRuleViolations.length).toBe(0);
    expect(good.parsed?.classified_evidence.length).toBe(3);
    expect(
      good.parsed?.classified_evidence.find((c) => c.evidence_id === "candidate-loop-framing")?.classification
    ).toBe("inconclusive");
  });

  it("hallucinated candidate id: parses but hallucinated citation caught", async () => {
    const hallucinated = await runValidationSandbox(new HallucinatedMockLLM(), validationInput);
    expect(hallucinated.parsed).not.toBeNull();
    expect(hallucinated.boundedRuleViolations.some((v) => v.includes("hallucinated citation"))).toBe(true);
  });
});
