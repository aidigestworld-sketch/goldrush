import { describe, it, expect } from "vitest";
import { runConfidenceSandbox } from "../confidenceSandbox";
import { confidenceInput } from "../__fixtures__/confidence-input";
import type { LLMClient } from "../llmClient";

class GoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypothesis_question:
        "Do the three competitors market a mechanism to distinguish platform-forced (involuntary) subscription cancellations from voluntary ones?",
      per_evidence_answers_question: {
        "ev-industry-distinction": false,
        "ev-shopifreaks-bug": false,
        "ev-loop-framing-para1": true,
        "ev-loop-framing-para2": true,
      },
      validation_score: 0.7,
      rationale:
        "Two evidence_against items from the same source (Loop framing paragraphs) directly address the hypothesis question by naming Loop's voluntary-vs-involuntary framing. Supporting evidence sets industry context but does not name the specific competitors' mechanisms. Two items answer, so the score sits inside the some-answering band; landed at 0.70 to reflect the shared-source counterweight and mixed authority tiers.",
    });
  }
}

class HallucinatedIdMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypothesis_question: "Do the three competitors distinguish involuntary vs voluntary cancellation?",
      per_evidence_answers_question: {
        "ev-industry-distinction": false,
        "ev-shopifreaks-bug": false,
        "ev-loop-framing-para1": true,
        "ev-loop-framing-para2": true,
        "ev-hallucinated-that-was-never-passed-in": true,
      },
      validation_score: 0.7,
      rationale:
        "Correctly identifies items 1 and 2 as answering, plus a fabricated citation the model wants to weight into its confidence — this is exactly the failure the bounded rule exists to catch.",
    });
  }
}

class OutOfBandScoreMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      hypothesis_question: "Do the three competitors distinguish involuntary vs voluntary cancellation?",
      per_evidence_answers_question: {
        "ev-industry-distinction": false,
        "ev-shopifreaks-bug": false,
        "ev-loop-framing-para1": false,
        "ev-loop-framing-para2": false,
      },
      validation_score: 0.85,
      rationale:
        "Model concluded that none of the four items directly answer the hypothesis question, then produced 0.85 anyway — treating source diversity and authority as substitute for direct-mechanism evidence. Should trigger the band-compliance bounded rule.",
    });
  }
}

describe("confidenceSandbox", () => {
  it("good response: parses, no validation errors, score inside some-answering band, every evidence_id real", async () => {
    const good = await runConfidenceSandbox(new GoodMockLLM(), confidenceInput);
    expect(good.parsed).not.toBeNull();
    expect(good.validationErrors.length).toBe(0);
    expect(good.boundedRuleViolations.length).toBe(0);
  });

  it("hallucinated evidence_id in per_evidence_answers_question: parses but hallucinated citation caught", async () => {
    const hallucinated = await runConfidenceSandbox(new HallucinatedIdMockLLM(), confidenceInput);
    expect(hallucinated.parsed).not.toBeNull();
    expect(hallucinated.boundedRuleViolations.some((v) => v.includes("hallucinated citation"))).toBe(true);
  });

  it("out-of-band score (0.85 with zero items answering, band ceiling 0.65): caught by band-compliance check", async () => {
    const outOfBand = await runConfidenceSandbox(new OutOfBandScoreMockLLM(), confidenceInput);
    expect(outOfBand.parsed).not.toBeNull();
    expect(outOfBand.boundedRuleViolations.some((v) => v.includes("outside the zero-answering"))).toBe(true);
  });
});
