// intakeTurn fix: original used `name` field on founder.create() which does not exist
// on the Founder model (fields are authUserId, expertise, industries, constraints, etc.).
// Fix: removed `name`, added missing required array fields.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../../db/client";
import {
  emptyIntakeState,
  recordFieldAsked,
  recordFieldAnswer,
  addContradictionFlag,
  detectContradiction,
  markIntakeComplete,
  checkCoverage,
  type FounderProfile,
} from "../founderIntakeState";
import { nextQuestion, QUESTIONS } from "../founderIntakeSequencer";
import { founderRepository } from "../../repositories/founder.repository";
import { founderEvidenceRepository } from "../../repositories/founderEvidence.repository";
import { runIntakeExtractionSandbox } from "../../sandbox/intakeExtractionSandbox";
import {
  runIntakeExtractionAgent,
  extractionOutputToString,
} from "../../agents/live/intakeExtractionAgent";
import type { LLMClient } from "../../sandbox/llmClient";

function mockLLM(response: string): LLMClient {
  return { complete: async () => response };
}

async function createTestFounder(): Promise<string> {
  const row = await prisma.founder.create({
    data: { expertise: [], industries: [], constraints: [], distributionAssets: [] },
  });
  return row.id;
}

async function cleanupFounder(id: string) {
  await prisma.founderEvidence.deleteMany({ where: { founderId: id } });
  await prisma.founder.delete({ where: { id } }).catch(() => {});
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("(1) first turn (no answer)", () => {
  it("sequencer returns expertise opener; fieldTarget=expertise; not done; not follow-up; questionCount increments", () => {
    let state = emptyIntakeState();
    const profile: FounderProfile = { expertise: [], distributionAssets: [], capitalAvailability: null };
    const seq = nextQuestion(state, profile);
    expect(!seq.done).toBe(true);
    expect(!seq.done && seq.nextQuestion === QUESTIONS.expertise.opener).toBe(true);
    expect(!seq.done && seq.fieldTarget === "expertise").toBe(true);
    expect(!seq.done && !seq.isFollowUp).toBe(true);

    state = recordFieldAsked(state, "expertise");
    expect(state.questionCount).toBe(1);
    expect(state.fields.expertise.asked).toBe(true);
  });
});

describe("(2)+(3) full three-field cycle + profile reflection", () => {
  it("expertise → distribution → capital writes profile to DB and marks done; 3 evidence rows created", async () => {
    const founderId = await createTestFounder();
    try {
      let state = emptyIntakeState();
      let profile: FounderProfile = { expertise: [], distributionAssets: [], capitalAvailability: null };

      // Turn 1 — expertise
      state = recordFieldAsked(state, "expertise");
      const ext1 = await runIntakeExtractionSandbox(
        mockLLM(JSON.stringify({ field: "expertise", extracted: ["Shopify app development", "subscription billing"] })),
        { field: "expertise", question: QUESTIONS.expertise.opener, rawAnswer: "I spent 6 years building Shopify apps, mostly subscription billing." }
      );
      expect(ext1.parsed).not.toBeNull();
      state = recordFieldAnswer(state, "expertise", "I spent 6 years building Shopify apps, mostly subscription billing.");
      await founderRepository.saveIntakeTurn(founderId, state, {
        targetField: "expertise",
        questionAsked: QUESTIONS.expertise.opener,
        rawAnswer: "I spent 6 years building Shopify apps, mostly subscription billing.",
        extractedValue: extractionOutputToString(ext1.parsed),
      });

      const f1 = await founderRepository.findById(founderId);
      profile = { expertise: (f1!.expertise ?? []) as string[], distributionAssets: [], capitalAvailability: null };
      expect(profile.expertise.length > 0).toBe(true);
      expect(profile.expertise.some((e) => e.includes("Shopify"))).toBe(true);

      // Turn 2 — distributionAssets
      const seq2 = nextQuestion(state, profile);
      expect(!seq2.done && seq2.fieldTarget === "distributionAssets").toBe(true);
      state = recordFieldAsked(state, "distributionAssets");
      const ext2 = await runIntakeExtractionSandbox(
        mockLLM(JSON.stringify({ field: "distributionAssets", extracted: ["Newsletter with 5k Shopify merchant subscribers"] })),
        { field: "distributionAssets", question: QUESTIONS.distributionAssets.opener, rawAnswer: "I have a newsletter with 5k Shopify merchant subscribers." }
      );
      state = recordFieldAnswer(state, "distributionAssets", "I have a newsletter with 5k Shopify merchant subscribers.");
      await founderRepository.saveIntakeTurn(founderId, state, {
        targetField: "distributionAssets",
        questionAsked: QUESTIONS.distributionAssets.opener,
        rawAnswer: "I have a newsletter with 5k Shopify merchant subscribers.",
        extractedValue: extractionOutputToString(ext2.parsed),
      });

      // Turn 3 — capitalAvailability
      const f2 = await founderRepository.findById(founderId);
      profile = {
        expertise: (f2!.expertise ?? []) as string[],
        distributionAssets: (f2!.distributionAssets ?? []) as string[],
        capitalAvailability: null,
      };
      const seq3 = nextQuestion(state, profile);
      expect(!seq3.done && seq3.fieldTarget === "capitalAvailability").toBe(true);
      state = recordFieldAsked(state, "capitalAvailability");
      const ext3 = await runIntakeExtractionSandbox(
        mockLLM(JSON.stringify({ field: "capitalAvailability", extracted: "$150K raised" })),
        { field: "capitalAvailability", question: QUESTIONS.capitalAvailability.opener, rawAnswer: "We raised $150K from angels." }
      );
      state = recordFieldAnswer(state, "capitalAvailability", "We raised $150K from angels.");
      await founderRepository.saveIntakeTurn(founderId, state, {
        targetField: "capitalAvailability",
        questionAsked: QUESTIONS.capitalAvailability.opener,
        rawAnswer: "We raised $150K from angels.",
        extractedValue: extractionOutputToString(ext3.parsed),
      });

      const f3 = await founderRepository.findById(founderId);
      profile = {
        expertise: (f3!.expertise ?? []) as string[],
        distributionAssets: (f3!.distributionAssets ?? []) as string[],
        capitalAvailability: f3!.capitalAvailability as string | null,
      };
      const seqFinal = nextQuestion(state, profile);
      expect(seqFinal.done).toBe(true);
      expect(seqFinal.done && !seqFinal.terminatedByCap).toBe(true);

      const finalState = markIntakeComplete(state);
      expect(finalState.completedAt).not.toBeNull();
      expect(checkCoverage(finalState).complete).toBe(true);
      expect(f3!.capitalAvailability).toBe("$150K raised");

      const evidenceRows = await founderEvidenceRepository.findByFounderId(founderId);
      expect(evidenceRows.length).toBe(3);
      expect(evidenceRows.some((r) => r.targetField === "expertise")).toBe(true);
      expect(evidenceRows.some((r) => r.targetField === "distribution_assets")).toBe(true);
      expect(evidenceRows.some((r) => r.targetField === "capital_availability")).toBe(true);
    } finally {
      await cleanupFounder(founderId);
    }
  });
});

describe("(4) contradiction flags", () => {
  it("solo↔team: flag detected with correct field1/field2 and unresolved; stored on state", () => {
    const profile: FounderProfile = {
      expertise: ["solopreneur, built all tools myself"],
      distributionAssets: [],
      capitalAvailability: null,
    };
    const flag = detectContradiction(profile, "distributionAssets", "my team has built a strong distribution network");
    expect(flag).not.toBeNull();
    expect(flag?.field1).toBe("expertise");
    expect(flag?.field2).toBe("distributionAssets");
    expect(flag?.resolved).toBe(false);

    let state = emptyIntakeState();
    state = addContradictionFlag(state, flag!);
    expect(state.contradictionFlags.length).toBe(1);
    expect(state.contradictionFlags[0].message.length > 0).toBe(true);
  });

  it("bootstrapped↔raised: flag detected with correct field1", () => {
    const profile: FounderProfile = { expertise: [], distributionAssets: [], capitalAvailability: "bootstrapped" };
    const flag = detectContradiction(profile, "capitalAvailability", "we raised a $500K seed round from three VCs");
    expect(flag).not.toBeNull();
    expect(flag?.field1).toBe("capitalAvailability");
  });

  it("raised↔bootstrapped (reverse direction): flag detected", () => {
    const profile: FounderProfile = { expertise: [], distributionAssets: [], capitalAvailability: "raised $1.2M Series A" };
    const flag = detectContradiction(profile, "capitalAvailability", "I'm fully self-funded, bootstrapped");
    expect(flag).not.toBeNull();
  });

  it("clean answer: no contradiction → null", () => {
    const profile: FounderProfile = { expertise: ["Shopify app developer"], distributionAssets: [], capitalAvailability: null };
    const flag = detectContradiction(profile, "distributionAssets", "I have a newsletter with 3,000 Shopify merchants");
    expect(flag).toBeNull();
  });
});

describe("(5) vague answer / null extraction", () => {
  it("null extraction → empty extractedValue stored; profile expertise unchanged; evidence row written", async () => {
    const founderId = await createTestFounder();
    try {
      const ext = await runIntakeExtractionSandbox(
        mockLLM(JSON.stringify({ field: "expertise", extracted: null })),
        { field: "expertise", question: QUESTIONS.expertise.opener, rawAnswer: "I do stuff." }
      );
      expect(ext.parsed).not.toBeNull();
      expect((ext.parsed as { extracted: unknown }).extracted).toBeNull();

      const extractedValue = extractionOutputToString(ext.parsed);
      expect(extractedValue).toBe("");

      let state = recordFieldAsked(emptyIntakeState(), "expertise");
      state = recordFieldAnswer(state, "expertise", "I do stuff.");
      await founderRepository.saveIntakeTurn(founderId, state, {
        targetField: "expertise",
        questionAsked: QUESTIONS.expertise.opener,
        rawAnswer: "I do stuff.",
        extractedValue,
      });

      const f = await founderRepository.findById(founderId);
      expect((f!.expertise as string[]).length).toBe(0);
      const rows = await founderEvidenceRepository.findByFounderId(founderId);
      expect(rows.length).toBe(1);
      expect(rows[0].extractedValue).toBe("");
    } finally {
      await cleanupFounder(founderId);
    }
  });
});

describe("(6) agent live wrapper", () => {
  it("success path: not skipped, output present, no validation errors, field correct", async () => {
    const founderId = await createTestFounder();
    try {
      const ok = await runIntakeExtractionAgent(
        founderId,
        { field: "distributionAssets", question: QUESTIONS.distributionAssets.opener, rawAnswer: "I have a Shopify App Store presence." },
        mockLLM(JSON.stringify({ field: "distributionAssets", extracted: ["Shopify App Store presence"] }))
      );
      expect(!ok.skipped).toBe(true);
      expect(ok.output).not.toBeNull();
      expect(ok.validationErrors.length).toBe(0);
      expect(ok.output?.field).toBe("distributionAssets");
    } finally {
      await cleanupFounder(founderId);
    }
  });

  it("failure path (invalid JSON): skipped=true, output=null, skipReason set", async () => {
    const founderId = await createTestFounder();
    try {
      const fail = await runIntakeExtractionAgent(
        founderId,
        { field: "expertise", question: QUESTIONS.expertise.opener, rawAnswer: "anything" },
        mockLLM("completely invalid JSON")
      );
      expect(fail.skipped).toBe(true);
      expect(fail.output).toBeNull();
      expect(typeof fail.skipReason).toBe("string");
    } finally {
      await cleanupFounder(founderId);
    }
  });

  it("extractionOutputToString helpers", () => {
    expect(extractionOutputToString(null)).toBe("");
    expect(extractionOutputToString({ field: "expertise", extracted: ["e-commerce", "Shopify"] })).toBe("e-commerce; Shopify");
    expect(extractionOutputToString({ field: "capitalAvailability", extracted: "$200K raised" })).toBe("$200K raised");
    expect(extractionOutputToString({ field: "distributionAssets", extracted: null })).toBe("");
    expect(extractionOutputToString({ field: "distributionAssets", extracted: [] })).toBe("");
  });
});
