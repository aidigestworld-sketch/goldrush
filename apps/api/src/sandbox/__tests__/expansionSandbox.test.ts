import { describe, it, expect } from "vitest";
import { runExpansionSandbox } from "../expansionSandbox";
import { expansionInputDocs } from "../__fixtures__/expansion-input-docs";
import { b2bExpansionInputDocs } from "../__fixtures__/b2b-expansion-input-docs";
import { b2bNimMalformedRawContent } from "../__fixtures__/b2b-expansion-nim-malformed";
import type { LLMClient } from "../llmClient";

const SHOPIFY_MARKET_LABEL = "Shopify subscription & recurring-order apps";
const B2B_MARKET_LABEL = "B2B customer support SaaS";

class GoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      audiences: [
        {
          label: "DTC/subscription merchants using Shop Pay for recurring billing",
          description: "Merchants running Shopify subscription commerce who rely on Shop Pay as a checkout/payment method for recurring orders.",
          evidence_refs: ["doc-101", "doc-102", "doc-103"],
        },
      ],
      problems: [
        {
          label: "Involuntary subscription cancellations misattributed as ordinary churn, caused by Shop Pay treating card removal as cancellation intent",
          problem_maturity: "recognized_unsolved",
          current_workaround_description: "Shopify allows reinstating the original payment method within a 24-hour window if the cancellation was accidental — a Shopify policy, not a merchant-side fix.",
          severity_signal: 0.6,
          severity_evidence_quote: "costing them a\nlarge number of customers",
          frequency_signal: 0.5,
          frequency_evidence_quote: "affecting many merchants broadly",
          evidence_refs: ["doc-101", "doc-102"],
        },
        {
          label: "Narrow, policy-driven reactivation window reduces win-back opportunity for accidental cancellations",
          problem_maturity: "unrecognized",
          current_workaround_description: null,
          severity_signal: null,
          severity_evidence_quote: null,
          frequency_signal: null,
          frequency_evidence_quote: null,
          evidence_refs: ["doc-103"],
        },
      ],
    });
  }
}

class ShallowMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      audiences: [{ label: "Shopify merchants", description: null, evidence_refs: ["doc-101"] }],
      problems: [
        {
          label: "High subscription churn",
          problem_maturity: "recognized_unsolved",
          current_workaround_description: null,
          severity_signal: 0.8,
          severity_evidence_quote: "this is a major problem",
          frequency_signal: 0.7,
          frequency_evidence_quote: "happens all the time",
          evidence_refs: ["doc-101", "doc-102", "doc-103"],
        },
      ],
    });
  }
}

class GoodB2BMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      audiences: [
        {
          label: "IT support teams at mid-market B2B SaaS companies",
          description: "Teams responsible for internal help desk operations where SLA adherence and ticket triage are primary operational concerns.",
          evidence_refs: ["b2b-doc-01", "b2b-doc-02"],
        },
      ],
      problems: [
        {
          label: "No automated triage to prioritize tickets by urgency before human review, causing SLA breaches during high-volume periods",
          problem_maturity: "recognized_unsolved",
          current_workaround_description: null,
          severity_signal: null,
          severity_evidence_quote: null,
          frequency_signal: 0.7,
          frequency_evidence_quote: "widely reported pain point",
          evidence_refs: ["b2b-doc-01"],
        },
        {
          label: "Missing queue-health visibility during platform slowdowns, forcing agents to duplicate effort on tickets they cannot confirm were received",
          problem_maturity: "recognized_unsolved",
          current_workaround_description: null,
          severity_signal: null,
          severity_evidence_quote: null,
          frequency_signal: null,
          frequency_evidence_quote: null,
          evidence_refs: ["b2b-doc-02"],
        },
        {
          label: "No automatic escalation path when tickets exceed a resolution threshold, causing silent stalls with no notification to submitter or supervisor",
          problem_maturity: "recognized_unsolved",
          current_workaround_description: null,
          severity_signal: null,
          severity_evidence_quote: null,
          frequency_signal: null,
          frequency_evidence_quote: null,
          evidence_refs: ["b2b-doc-03"],
        },
      ],
    });
  }
}

class B2BLeakageMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      audiences: [{ label: "B2B support agents", description: null, evidence_refs: ["b2b-doc-01"] }],
      problems: [
        {
          label: "No real-time SLA dashboard visible to agents during ticket triage",
          problem_maturity: "recognized_unsolved",
          current_workaround_description: null,
          severity_signal: 0.9,
          severity_evidence_quote: "crushing our SLA compliance every single quarter",
          frequency_signal: null,
          frequency_evidence_quote: null,
          evidence_refs: ["b2b-doc-01"],
        },
      ],
    });
  }
}

class MalformedNimB2BLLM implements LLMClient {
  private callCount = 0;
  async complete(): Promise<string> {
    this.callCount++;
    return b2bNimMalformedRawContent;
  }
  getCallCount() { return this.callCount; }
}

class MalformedThenValidB2BLLM implements LLMClient {
  private callCount = 0;
  async complete(): Promise<string> {
    this.callCount++;
    if (this.callCount === 1) return "";
    return JSON.stringify({
      audiences: [{ label: "IT support teams", description: null, evidence_refs: ["b2b-doc-01"] }],
      problems: [{
        label: "No automated triage to prioritize tickets before human review",
        problem_maturity: "recognized_unsolved",
        current_workaround_description: null,
        severity_signal: null,
        severity_evidence_quote: null,
        frequency_signal: null,
        frequency_evidence_quote: null,
        evidence_refs: ["b2b-doc-01"],
      }],
    });
  }
  getCallCount() { return this.callCount; }
}

describe("expansionSandbox — shopify_subscriptions", () => {
  it("good response: parses, no validation errors, grounded quotes pass, extracts 2 problems", async () => {
    const good = await runExpansionSandbox(new GoodMockLLM(), expansionInputDocs, SHOPIFY_MARKET_LABEL);
    expect(good.parsed).not.toBeNull();
    expect(good.validationErrors.length).toBe(0);
    expect(good.boundedRuleViolations.length).toBe(0);
    expect(good.parsed?.problems.length).toBe(2);
  });

  it("shallow response: parses; fabricated severity/frequency quotes are STRIPPED (signal→null), not recorded as BRVs", async () => {
    // NOTE: the original script test asserted boundedRuleViolations containing "fabricated grounding",
    // but expansionSandbox.ts intentionally STRIPS ungrounded signal/quote pairs silently
    // (see stripIfUngrounded — it nulls the fields rather than pushing a BRV, to avoid
    // retry loops when the LLM paraphrases rather than verbatim-copying). The correct
    // assertion is that the fabricated signals are nulled out in the parsed output.
    const shallow = await runExpansionSandbox(new ShallowMockLLM(), expansionInputDocs, SHOPIFY_MARKET_LABEL);
    expect(shallow.parsed).not.toBeNull();
    expect(shallow.parsed?.problems[0]?.severity_signal).toBeNull();
    expect(shallow.parsed?.problems[0]?.severity_evidence_quote).toBeNull();
    expect(shallow.parsed?.problems[0]?.frequency_signal).toBeNull();
    expect(shallow.parsed?.problems[0]?.frequency_evidence_quote).toBeNull();
  });
});

describe("expansionSandbox — b2b_customer_support_saas", () => {
  it("b2b good response: parses, no errors, ≥1 audience, ≥2 problems, all gap-framed", async () => {
    const b2bGood = await runExpansionSandbox(new GoodB2BMockLLM(), b2bExpansionInputDocs, B2B_MARKET_LABEL);
    expect(b2bGood.parsed).not.toBeNull();
    expect(b2bGood.validationErrors.length).toBe(0);
    expect(b2bGood.boundedRuleViolations.length).toBe(0);
    expect((b2bGood.parsed?.audiences.length ?? 0) >= 1).toBe(true);
    expect((b2bGood.parsed?.problems.length ?? 0) >= 2).toBe(true);
    expect(
      b2bGood.parsed?.problems.every((p) =>
        /^(No way|No |Users cannot|Missing ability|Missing |Cannot )/i.test(p.label)
      ) ?? false
    ).toBe(true);
  });

  it("b2b leakage: fabricated severity quote STRIPPED (signal→null) — grounding discipline survives parameterization", async () => {
    // Same stripIfUngrounded behavior as the shallow case: ungrounded severity quote
    // is nulled out in parsed output, not recorded as a BRV.
    const b2bLeakage = await runExpansionSandbox(new B2BLeakageMockLLM(), b2bExpansionInputDocs, B2B_MARKET_LABEL);
    expect(b2bLeakage.parsed).not.toBeNull();
    expect(b2bLeakage.parsed?.problems[0]?.severity_signal).toBeNull();
    expect(b2bLeakage.parsed?.problems[0]?.severity_evidence_quote).toBeNull();
  });
});

describe("expansionSandbox — jsonrepair recovery (real b2b NIM malformed fragment)", () => {
  it("malformed NIM fragment recovered by jsonrepair without a retry LLM call", async () => {
    const malformedLlm = new MalformedNimB2BLLM();
    const repaired = await runExpansionSandbox(malformedLlm, b2bExpansionInputDocs, B2B_MARKET_LABEL);
    expect(repaired.parsed).not.toBeNull();
    expect(repaired.validationErrors.length).toBe(0);
    expect(repaired.boundedRuleViolations.length).toBe(0);
    expect(repaired.repaired).toBe(true);
    expect(repaired.retried).toBe(false);
    expect(malformedLlm.getCallCount()).toBe(1);
    expect((repaired.parsed?.problems.length ?? 0) >= 2).toBe(true);
    expect(
      repaired.parsed?.problems.every((p) =>
        /^(No way|No |Users cannot|Missing ability|Missing |Cannot )/i.test(p.label)
      ) ?? false
    ).toBe(true);
  });
});

describe("expansionSandbox — fabricationStrips counter", () => {
  it("grounded quotes (GoodMockLLM): fabricationStrips is {severity:0, frequency:0}", async () => {
    const good = await runExpansionSandbox(new GoodMockLLM(), expansionInputDocs, SHOPIFY_MARKET_LABEL);
    expect(good.fabricationStrips).toEqual({ severity: 0, frequency: 0 });
  });

  it("fabricated quotes (ShallowMockLLM): fabricationStrips records one severity and one frequency strip", async () => {
    const shallow = await runExpansionSandbox(new ShallowMockLLM(), expansionInputDocs, SHOPIFY_MARKET_LABEL);
    expect(shallow.fabricationStrips).toEqual({ severity: 1, frequency: 1 });
  });
});

describe("expansionSandbox — retry path (repair fails → second LLM call succeeds)", () => {
  it("empty first response triggers retry, second call returns valid JSON", async () => {
    const retryLlm = new MalformedThenValidB2BLLM();
    const afterRetry = await runExpansionSandbox(retryLlm, b2bExpansionInputDocs, B2B_MARKET_LABEL);
    expect(afterRetry.parsed).not.toBeNull();
    expect(afterRetry.validationErrors.length).toBe(0);
    expect(afterRetry.retried).toBe(true);
    expect(retryLlm.getCallCount()).toBe(2);
  });
});
