import { describe, it, expect } from "vitest";
import { runValidationSandbox, runValidationSandboxBatched, VALIDATION_MAX_ROWS_PER_BATCH } from "../validationSandbox";
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

// Simulates nvidia-nemotron-nano-9b-v2's habit of prepending prose before JSON.
class ProsePreambleMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return (
      "Based on the candidates provided, here is my classification:\n\n" +
      JSON.stringify({
        classified_evidence: [
          {
            evidence_id: "candidate-loop-framing",
            classification: "inconclusive",
            note: "Loop does market a voluntary-vs-involuntary distinction, but their framing is specifically about payment-failure-driven churn (declined cards, insufficient funds), not the Shop-Pay-card-removal mechanism this hypothesis describes. Topically related, mechanism does not match.",
          },
        ],
        unresolved_questions: [],
        additional_search_queries_would_run: [],
      })
    );
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

  it("prose preamble before JSON: extractAndClean strips preamble and parses correctly", async () => {
    const result = await runValidationSandbox(new ProsePreambleMockLLM(), validationInput);
    expect(result.parsed).not.toBeNull();
    expect(result.validationErrors.length).toBe(0);
    expect(result.parsed?.classified_evidence.length).toBe(1);
    expect(result.parsed?.classified_evidence[0].classification).toBe("inconclusive");
  });

  it("hallucinated candidate id: parses but hallucinated citation caught", async () => {
    const hallucinated = await runValidationSandbox(new HallucinatedMockLLM(), validationInput);
    expect(hallucinated.parsed).not.toBeNull();
    expect(hallucinated.boundedRuleViolations.some((v) => v.includes("hallucinated citation"))).toBe(true);
  });
});

// Batching regression: on 2026-07-17 a 131-row Validation call on
// nvidia/llama-3.3-nemotron-super-49b-v1.5 hit the NIM ~300s inference
// gateway wall at 8192 output tokens (finish=length). Splitting into
// ≤60-row batches keeps each parallel call under ~150s and scales with
// corpus growth. These tests pin the batching contract that keeps the
// concatenation semantically equivalent to a single call.
describe("validationSandbox — batched", () => {
  it("candidates ≤ batchSize: exactly one LLM call (delegates to runValidationSandbox)", async () => {
    let calls = 0;
    class CountingLLM {
      async complete(): Promise<string> {
        calls++;
        return JSON.stringify({
          classified_evidence: [
            { evidence_id: "candidate-loop-framing", classification: "supports", note: "twenty character note ok fine" },
          ],
          unresolved_questions: [],
          additional_search_queries_would_run: [],
        });
      }
    }
    const result = await runValidationSandboxBatched(new CountingLLM(), validationInput);
    expect(calls).toBe(1);
    expect(result.parsed).not.toBeNull();
  });

  it("candidates > batchSize: splits into N parallel batches, concatenates classified_evidence, dedupes questions/queries", async () => {
    // Build 150 synthetic candidates → 3 batches of 60/60/30 at default batchSize=60.
    const bigInput = {
      hypothesis: validationInput.hypothesis,
      candidates: Array.from({ length: 150 }, (_, i) => ({
        id: `cand-${i}`,
        sourceUrlOrIdentifier: `https://example.com/${i}`,
        text: `candidate text ${i}`,
      })),
    };

    let batchCall = 0;
    class BatchingCountingLLM {
      async complete(_sys: string, user: string): Promise<string> {
        batchCall++;
        // Return classifications for exactly the candidates in this batch's
        // user prompt so the merged result covers all 150.
        const idsInBatch = [...user.matchAll(/\[candidate id="(cand-\d+)"/g)].map((m) => m[1]);
        return JSON.stringify({
          classified_evidence: idsInBatch.map((id) => ({
            evidence_id: id,
            classification: "inconclusive",
            note: "batched classification note passing the min 20 char requirement.",
          })),
          // Deliberately identical across batches so we can verify dedupe.
          unresolved_questions: ["Same broad gap surfaced by every batch"],
          additional_search_queries_would_run: ["shared retry query"],
        });
      }
    }

    const result = await runValidationSandboxBatched(new BatchingCountingLLM(), bigInput);
    expect(batchCall).toBe(Math.ceil(150 / VALIDATION_MAX_ROWS_PER_BATCH));
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.classified_evidence.length).toBe(150);
    // Coverage: every input id ended up classified exactly once — no
    // batch boundary drops or duplicates.
    const outIds = result.parsed!.classified_evidence.map((c) => c.evidence_id).sort();
    const inIds = bigInput.candidates.map((c) => c.id).sort();
    expect(outIds).toEqual(inIds);
    // Dedupe: three batches each emitted the same question/query, merged as one.
    expect(result.parsed!.unresolved_questions.length).toBe(1);
    expect(result.parsed!.additional_search_queries_would_run.length).toBe(1);
    // raw_output preserves per-batch responses with delimiters for debugging.
    expect(result.rawResponse).toContain("--- batch 1/3 ---");
    expect(result.rawResponse).toContain("--- batch 3/3 ---");
  });

  it("fail-loud: if any batch fails schema validation, whole invocation returns parsed=null with tagged errors (no partial writes)", async () => {
    const bigInput = {
      hypothesis: validationInput.hypothesis,
      candidates: Array.from({ length: 120 }, (_, i) => ({
        id: `cand-${i}`,
        sourceUrlOrIdentifier: `https://example.com/${i}`,
        text: `candidate text ${i}`,
      })),
    };

    let call = 0;
    class OneBadBatchLLM {
      async complete(_sys: string, user: string): Promise<string> {
        call++;
        const idsInBatch = [...user.matchAll(/\[candidate id="(cand-\d+)"/g)].map((m) => m[1]);
        // Batch 2 returns garbage — batch 1 returns valid JSON.
        if (call === 2) return "not valid json at all";
        return JSON.stringify({
          classified_evidence: idsInBatch.map((id) => ({
            evidence_id: id,
            classification: "inconclusive",
            note: "batched classification note passing the min 20 char requirement.",
          })),
          unresolved_questions: [],
          additional_search_queries_would_run: [],
        });
      }
    }

    const result = await runValidationSandboxBatched(new OneBadBatchLLM(), bigInput);
    expect(result.parsed).toBeNull();
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.validationErrors.some((e) => e.startsWith("[batch 2/2]"))).toBe(true);
  });
});
