import { describe, it, expect } from "vitest";
import {
  runIntakeExtractionSandbox,
  type IntakeExtractionOutput,
} from "../intakeExtractionSandbox";
import type { LLMClient } from "../llmClient";

function mockLLM(response: string): LLMClient {
  return { complete: async () => response };
}

describe("intakeExtractionSandbox — expertise", () => {
  it("realistic answer: parses, field discriminator correct, 3 domain terms extracted", async () => {
    const llm = mockLLM(
      JSON.stringify({ field: "expertise", extracted: ["e-commerce marketing", "Shopify app development", "subscription billing"] })
    );
    const result = await runIntakeExtractionSandbox(llm, {
      field: "expertise",
      question: "What's your professional background?",
      rawAnswer: "I've spent 7 years in e-commerce marketing and Shopify app development, mostly around subscription billing platforms.",
    });
    expect(result.parsed).not.toBeNull();
    expect(result.parsed?.field).toBe("expertise");
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "expertise" }>)?.extracted;
    expect(Array.isArray(extracted) && extracted.length === 3).toBe(true);
    expect(extracted?.includes("e-commerce marketing")).toBe(true);
    expect(result.validationErrors.length).toBe(0);
  });

  it("vague answer → extracted is null (nothing extractable)", async () => {
    const llm = mockLLM(JSON.stringify({ field: "expertise", extracted: null }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "expertise",
      question: "What's your professional background?",
      rawAnswer: "I'm in software.",
    });
    expect(result.parsed).not.toBeNull();
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "expertise" }>)?.extracted;
    expect(extracted).toBeNull();
  });

  it("field-injection defense: model omits 'field' key → field injected from caller context", async () => {
    const llm = mockLLM(JSON.stringify({ extracted: ["DTC brand operations", "Shopify Plus"] }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "expertise",
      question: "What's your professional background?",
      rawAnswer: "I ran a DTC brand on Shopify Plus for 4 years.",
    });
    expect(result.parsed).not.toBeNull();
    expect(result.parsed?.field).toBe("expertise");
  });

  it("empty string filtering: empty strings filtered from array", async () => {
    const llm = mockLLM(JSON.stringify({ field: "expertise", extracted: ["", "B2B SaaS sales", ""] }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "expertise",
      question: "What's your professional background?",
      rawAnswer: "I did B2B SaaS sales for 5 years.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "expertise" }>)?.extracted;
    expect(extracted?.length === 1 && extracted[0] === "B2B SaaS sales").toBe(true);
  });
});

describe("intakeExtractionSandbox — distributionAssets", () => {
  it("specific named channels: parses, 2 channels extracted", async () => {
    const llm = mockLLM(
      JSON.stringify({
        field: "distributionAssets",
        extracted: ["Newsletter with 8k e-commerce subscribers", "LinkedIn network of 3k DTC merchants"],
      })
    );
    const result = await runIntakeExtractionSandbox(llm, {
      field: "distributionAssets",
      question: "Do you have existing channels to reach customers?",
      rawAnswer: "I have a newsletter with 8k e-commerce subscribers and a LinkedIn network of around 3k DTC merchants.",
    });
    expect(result.parsed).not.toBeNull();
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "distributionAssets" }>)?.extracted;
    expect(extracted?.length).toBe(2);
    expect(extracted?.[0]).toBe("Newsletter with 8k e-commerce subscribers");
  });

  it("explicit 'I have none' → empty array (not null)", async () => {
    const llm = mockLLM(JSON.stringify({ field: "distributionAssets", extracted: [] }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "distributionAssets",
      question: "Do you have existing channels to reach customers?",
      rawAnswer: "No, I have no existing distribution channels or audience.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "distributionAssets" }>)?.extracted;
    expect(Array.isArray(extracted) && extracted.length === 0).toBe(true);
  });

  it("vague 'I know people' → null (nothing extractable without named channel)", async () => {
    const llm = mockLLM(JSON.stringify({ field: "distributionAssets", extracted: null }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "distributionAssets",
      question: "Do you have existing channels to reach customers?",
      rawAnswer: "I know a lot of people in the industry.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "distributionAssets" }>)?.extracted;
    expect(extracted).toBeNull();
  });
});

describe("intakeExtractionSandbox — capitalAvailability", () => {
  it("'bootstrapped' normalized correctly", async () => {
    const llm = mockLLM(JSON.stringify({ field: "capitalAvailability", extracted: "bootstrapped" }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "capitalAvailability",
      question: "What's your current capital situation?",
      rawAnswer: "We bootstrapped, no outside money.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "capitalAvailability" }>)?.extracted;
    expect(extracted).toBe("bootstrapped");
  });

  it("specific raise amount normalized", async () => {
    const llm = mockLLM(JSON.stringify({ field: "capitalAvailability", extracted: "$200K raised" }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "capitalAvailability",
      question: "What's your current capital situation?",
      rawAnswer: "We raised a $200K seed round last year.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "capitalAvailability" }>)?.extracted;
    expect(extracted).toBe("$200K raised");
  });

  it("off-topic / vague → null (nothing extractable)", async () => {
    const llm = mockLLM(JSON.stringify({ field: "capitalAvailability", extracted: null }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "capitalAvailability",
      question: "What's your current capital situation?",
      rawAnswer: "That's a great question, I'll have to think about it.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "capitalAvailability" }>)?.extracted;
    expect(extracted).toBeNull();
  });
});

describe("intakeExtractionSandbox — teamSize", () => {
  it("resolvable head count → number extracted", async () => {
    const llm = mockLLM(JSON.stringify({ field: "teamSize", extracted: 3 }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "teamSize",
      question: "How many people are working on this?",
      rawAnswer: "It's me and two co-founders, three of us full time.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "teamSize" }>)?.extracted;
    expect(extracted).toBe(3);
    expect(result.validationErrors.length).toBe(0);
  });

  it("vague 'small team' → null (not guessed)", async () => {
    const llm = mockLLM(JSON.stringify({ field: "teamSize", extracted: null }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "teamSize",
      question: "How many people are working on this?",
      rawAnswer: "A small team.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "teamSize" }>)?.extracted;
    expect(extracted).toBeNull();
  });

  it("zero rejected by schema (positive integer required) — validation fails", async () => {
    const llm = mockLLM(JSON.stringify({ field: "teamSize", extracted: 0 }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "teamSize",
      question: "How many people are working on this?",
      rawAnswer: "Nobody yet.",
    });
    expect(result.parsed).toBeNull();
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });
});

describe("intakeExtractionSandbox — geography", () => {
  it("specific country extracted", async () => {
    const llm = mockLLM(JSON.stringify({ field: "geography", extracted: "United States" }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "geography",
      question: "Where are you based?",
      rawAnswer: "We're in the United States, mostly the Bay Area.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "geography" }>)?.extracted;
    expect(extracted).toBe("United States");
  });

  it("vague 'remote' → null (no specific place stated)", async () => {
    const llm = mockLLM(JSON.stringify({ field: "geography", extracted: null }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "geography",
      question: "Where are you based?",
      rawAnswer: "We're fully remote, everywhere.",
    });
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "geography" }>)?.extracted;
    expect(extracted).toBeNull();
  });
});

describe("intakeExtractionSandbox — schema validation", () => {
  it("malformed JSON: parsed is null, validationErrors populated with correct prefix", async () => {
    const llm = mockLLM("this is not json at all");
    const result = await runIntakeExtractionSandbox(llm, {
      field: "expertise",
      question: "What's your background?",
      rawAnswer: "anything",
    });
    expect(result.parsed).toBeNull();
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.validationErrors[0].startsWith("JSON parse failed")).toBe(true);
  });

  it("wrong shape (expertise returns string instead of array): parsed is null, validationErrors populated", async () => {
    const llm = mockLLM(JSON.stringify({ field: "expertise", extracted: "not an array" }));
    const result = await runIntakeExtractionSandbox(llm, {
      field: "expertise",
      question: "What's your background?",
      rawAnswer: "anything",
    });
    expect(result.parsed).toBeNull();
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  it("markdown code fences stripped and parsed successfully", async () => {
    const llm = mockLLM('```json\n{ "field": "capitalAvailability", "extracted": "revenue-funded" }\n```');
    const result = await runIntakeExtractionSandbox(llm, {
      field: "capitalAvailability",
      question: "What's your current capital situation?",
      rawAnswer: "The business pays for itself via revenue.",
    });
    expect(result.parsed).not.toBeNull();
    const extracted = (result.parsed as Extract<IntakeExtractionOutput, { field: "capitalAvailability" }>)?.extracted;
    expect(extracted).toBe("revenue-funded");
  });
});
