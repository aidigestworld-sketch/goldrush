import { describe, it, expect } from "vitest";
import { runHypothesisSandbox } from "../hypothesisSandbox";
import { hypothesisInput } from "../__fixtures__/hypothesis-input";
import type { LLMClient } from "../llmClient";

class GoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypotheses: [
        {
          statement:
            "Existing solutions (Recharge, Loop Subscriptions, Bold Subscriptions) lack a mechanism to differentiate between intentional and unintentional subscription cancellations caused by payment method changes, focusing solely on dunning and payment recovery for voluntary churn.",
          gap_type: "positioning",
          evidence_for: [
            "173a0c23-e41d-4c32-af0c-d484c9add01a",
            "08902600-d4e9-45c4-bf8f-773277500c27",
          ],
          evidence_against: [],
          existing_solutions_considered: [
            "08902600-d4e9-45c4-bf8f-773277500c27",
            "46d3dd86-8315-44a7-acdf-98268ebc6f8c",
            "27d0cfe3-f490-4d4e-abd0-9a6c5d23ecb7",
          ],
          missing_data: [
            "Whether Recharge's dunning tooling has an unmarketed capability to distinguish forced vs. voluntary churn — not stated in the available positioning text",
          ],
          confidence: 0.6,
        },
      ],
    });
  }
}

class SingleSourceMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypotheses: [
        {
          statement: "Some shallow restatement built from one source cited twice.",
          gap_type: "positioning",
          evidence_for: [
            "08902600-d4e9-45c4-bf8f-773277500c27",
            "08902600-d4e9-45c4-bf8f-773277500c27",
          ],
          evidence_against: [],
          existing_solutions_considered: ["08902600-d4e9-45c4-bf8f-773277500c27"],
          missing_data: [],
          confidence: 0.5,
        },
      ],
    });
  }
}

class HallucinatedMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypotheses: [
        {
          statement: "A hypothesis citing evidence that doesn't exist.",
          gap_type: "pricing",
          evidence_for: ["nonexistent-id-1", "nonexistent-id-2"],
          evidence_against: [],
          existing_solutions_considered: [],
          missing_data: [],
          confidence: 0.5,
        },
      ],
    });
  }
}

class HallucinatedSolutionMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypotheses: [
        {
          statement: "A hypothesis that references a competitor not actually in the input.",
          gap_type: "positioning",
          evidence_for: [
            "173a0c23-e41d-4c32-af0c-d484c9add01a",
            "08902600-d4e9-45c4-bf8f-773277500c27",
          ],
          evidence_against: [],
          existing_solutions_considered: ["nonexistent-competitor-id"],
          missing_data: [],
          confidence: 0.5,
        },
      ],
    });
  }
}

describe("hypothesisSandbox", () => {
  it("good response: parses, no validation errors, 2-distinct-source citation and 3 real competitor refs both pass", async () => {
    const good = await runHypothesisSandbox(new GoodMockLLM(), hypothesisInput);
    expect(good.parsed).not.toBeNull();
    expect(good.validationErrors.length).toBe(0);
    expect(good.boundedRuleViolations.length).toBe(0);
    expect(good.parsed?.hypotheses[0]?.existing_solutions_considered.length).toBe(3);
  });

  it("single-source (same id cited twice): parses but Bounded Synthesis Rule violation fired", async () => {
    const singleSource = await runHypothesisSandbox(new SingleSourceMockLLM(), hypothesisInput);
    expect(singleSource.parsed).not.toBeNull();
    expect(singleSource.boundedRuleViolations.some((v) => v.includes("distinct source"))).toBe(true);
  });

  it("hallucinated evidence_for ids: parses but hallucinated citation caught", async () => {
    const hallucinated = await runHypothesisSandbox(new HallucinatedMockLLM(), hypothesisInput);
    expect(hallucinated.parsed).not.toBeNull();
    expect(hallucinated.boundedRuleViolations.some((v) => v.includes("hallucinated citation"))).toBe(true);
  });

  it("hallucinated existing_solutions_considered id: parses but hallucinated competitor reference caught", async () => {
    const hallucinatedSolution = await runHypothesisSandbox(new HallucinatedSolutionMockLLM(), hypothesisInput);
    expect(hallucinatedSolution.parsed).not.toBeNull();
    expect(hallucinatedSolution.boundedRuleViolations.some((v) => v.includes("hallucinated competitor reference"))).toBe(true);
  });
});
