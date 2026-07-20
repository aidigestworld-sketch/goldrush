import { describe, it, expect } from "vitest";
import {
  emptyIntakeState,
  checkCoverage,
  recordFieldAsked,
  recordFollowUpAsked,
  recordFieldAnswer,
  forceCompleteByCapTermination,
  markIntakeComplete,
  detectContradiction,
  addContradictionFlag,
  resolveContradictionFlag,
  MAX_QUESTIONS,
  type FounderIntakeState,
  type FounderProfile,
} from "../founderIntakeState";
import { nextQuestion, QUESTIONS } from "../founderIntakeSequencer";

// ── Helpers ──────────────────────────────────────────────────────────────────

const emptyProfile: FounderProfile = {
  expertise: [],
  distributionAssets: [],
  capitalAvailability: null,
  teamSize: null,
  geography: null,
};

function simulateTurns(
  turns: Array<{
    field: "expertise" | "distributionAssets" | "capitalAvailability" | "teamSize" | "geography";
    answerText: string;
    answerValues: {
      expertise?: string[];
      distributionAssets?: string[];
      capitalAvailability?: string | null;
      teamSize?: number | null;
      geography?: string | null;
    };
    isFollowUp?: boolean;
  }>
): { state: FounderIntakeState; profile: FounderProfile } {
  let state = emptyIntakeState();
  let profile = { ...emptyProfile };
  for (const turn of turns) {
    if (turn.isFollowUp) {
      state = recordFollowUpAsked(state, turn.field);
    } else {
      state = recordFieldAsked(state, turn.field);
    }
    state = recordFieldAnswer(state, turn.field, turn.answerText);
    if (turn.answerValues.expertise !== undefined) profile = { ...profile, expertise: turn.answerValues.expertise };
    if (turn.answerValues.distributionAssets !== undefined) profile = { ...profile, distributionAssets: turn.answerValues.distributionAssets };
    if (turn.answerValues.capitalAvailability !== undefined) profile = { ...profile, capitalAvailability: turn.answerValues.capitalAvailability };
    if (turn.answerValues.teamSize !== undefined) profile = { ...profile, teamSize: turn.answerValues.teamSize };
    if (turn.answerValues.geography !== undefined) profile = { ...profile, geography: turn.answerValues.geography };
  }
  return { state, profile };
}

// ── (1) Coverage / completion criteria ───────────────────────────────────────

describe("(1) Coverage / completion criteria", () => {
  it("fresh state → not complete, all 5 fields remaining", () => {
    const fresh = emptyIntakeState();
    const cov = checkCoverage(fresh);
    expect(cov.complete).toBe(false);
    expect(
      cov.remainingFields.length === 5 &&
        cov.remainingFields.includes("expertise") &&
        cov.remainingFields.includes("distributionAssets") &&
        cov.remainingFields.includes("capitalAvailability") &&
        cov.remainingFields.includes("teamSize") &&
        cov.remainingFields.includes("geography")
    ).toBe(true);
  });

  it("1/5 asked → not complete, correct 4 remaining fields", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    const cov = checkCoverage(state);
    expect(cov.complete).toBe(false);
    expect(
      cov.remainingFields.length === 4 &&
        !cov.remainingFields.includes("expertise") &&
        cov.remainingFields.includes("distributionAssets") &&
        cov.remainingFields.includes("capitalAvailability") &&
        cov.remainingFields.includes("teamSize") &&
        cov.remainingFields.includes("geography")
    ).toBe(true);
  });

  it("all 5 asked → complete, no remaining fields", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAsked(state, "distributionAssets");
    state = recordFieldAsked(state, "capitalAvailability");
    state = recordFieldAsked(state, "teamSize");
    state = recordFieldAsked(state, "geography");
    const cov = checkCoverage(state);
    expect(cov.complete).toBe(true);
    expect(cov.remainingFields.length).toBe(0);
  });

  it("asked=true with empty values still counts as complete", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAnswer(state, "expertise", "");
    state = recordFieldAsked(state, "distributionAssets");
    state = recordFieldAnswer(state, "distributionAssets", "");
    state = recordFieldAsked(state, "capitalAvailability");
    state = recordFieldAsked(state, "teamSize");
    state = recordFieldAnswer(state, "teamSize", "");
    state = recordFieldAsked(state, "geography");
    state = recordFieldAnswer(state, "geography", "");
    const cov = checkCoverage(state);
    expect(cov.complete).toBe(true);
  });
});

// ── (2) State-transition helpers ─────────────────────────────────────────────

describe("(2) State-transition helpers", () => {
  it("recordFieldAsked: sets asked=true, askedAt, increments questionCount, original immutable", () => {
    const before = emptyIntakeState();
    const after = recordFieldAsked(before, "expertise");
    expect(after.fields.expertise.asked).toBe(true);
    expect(after.fields.expertise.askedAt).not.toBeNull();
    expect(after.questionCount).toBe(1);
    expect(before.questionCount).toBe(0);
  });

  it("recordFieldAnswer: depth populated, word count correct, questionCount unchanged", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAnswer(state, "expertise", "I built Shopify apps for 5 years and ran a DTC brand");
    expect(state.fields.expertise.depth).not.toBeNull();
    expect(state.fields.expertise.depth!.wordCount).toBe(12);
    expect(state.questionCount).toBe(1);
  });

  it("recordFollowUpAsked: sets followUpAsked=true, increments questionCount, preserves asked=true", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    const afterFollowUp = recordFollowUpAsked(state, "expertise");
    expect(afterFollowUp.fields.expertise.followUpAsked).toBe(true);
    expect(afterFollowUp.questionCount).toBe(2);
    expect(afterFollowUp.fields.expertise.asked).toBe(true);
  });

  it("forceCompleteByCapTermination: unasked fields marked asked+capTerminated, completedAt set", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    const fixed = forceCompleteByCapTermination(state);
    expect(fixed.fields.expertise.capTerminated).toBe(false);
    expect(fixed.fields.distributionAssets.asked).toBe(true);
    expect(fixed.fields.distributionAssets.capTerminated).toBe(true);
    expect(fixed.fields.capitalAvailability.capTerminated).toBe(true);
    expect(fixed.fields.teamSize.capTerminated).toBe(true);
    expect(fixed.fields.geography.capTerminated).toBe(true);
    expect(fixed.completedAt).not.toBeNull();
  });

  it("markIntakeComplete: sets completedAt, idempotent", () => {
    const state = emptyIntakeState();
    const completed = markIntakeComplete(state);
    expect(completed.completedAt).not.toBeNull();
    const reCompleted = markIntakeComplete(completed);
    expect(reCompleted.completedAt).toBe(completed.completedAt);
  });
});

// ── (3) Sequencer — realistic traces ─────────────────────────────────────────

describe("(3) Sequencer — realistic traces", () => {
  it("trace A: fresh state → expertise opener, not done", () => {
    const q = nextQuestion(emptyIntakeState(), emptyProfile);
    expect(q.done).toBe(false);
    expect(!q.done && q.nextQuestion === QUESTIONS.expertise.opener).toBe(true);
    expect(!q.done && q.fieldTarget === "expertise").toBe(true);
    expect(!q.done && !q.isFollowUp).toBe(true);
  });

  it("trace B: vague expertise answer → follow-up issued", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAnswer(state, "expertise", "software");
    const profile: FounderProfile = { ...emptyProfile, expertise: ["software"] };
    const q = nextQuestion(state, profile);
    expect(q.done).toBe(false);
    expect(!q.done && q.nextQuestion === QUESTIONS.expertise.followUp).toBe(true);
    expect(!q.done && q.isFollowUp === true).toBe(true);
    expect(!q.done && q.fieldTarget === "expertise").toBe(true);
  });

  it("trace C: specific expertise answer → skip follow-up, go to distribution", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAnswer(state, "expertise", "I spent 7 years building Shopify subscription apps at a bootstrapped agency");
    const profile: FounderProfile = {
      ...emptyProfile,
      expertise: ["7 years building Shopify subscription apps at a bootstrapped agency"],
    };
    const q = nextQuestion(state, profile);
    expect(q.done).toBe(false);
    expect(!q.done && q.nextQuestion === QUESTIONS.distributionAssets.opener).toBe(true);
    expect(!q.done && q.fieldTarget === "distributionAssets").toBe(true);
  });

  it("trace D: expertise+dist asked → capital next", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAsked(state, "distributionAssets");
    const profile: FounderProfile = {
      expertise: ["Shopify app developer with 5 years experience in DTC"],
      distributionAssets: [],
      capitalAvailability: null,
      teamSize: null,
      geography: null,
    };
    const q = nextQuestion(state, profile);
    expect(q.done).toBe(false);
    expect(!q.done && q.nextQuestion === QUESTIONS.capitalAvailability.opener).toBe(true);
  });

  it("trace E: all 5 fields asked → done by coverage, not cap", () => {
    const { state } = simulateTurns([
      { field: "expertise", answerText: "Shopify developer 5 years", answerValues: { expertise: ["Shopify developer", "5 years SaaS"] } },
      { field: "distributionAssets", answerText: "Email list of 2000 subscribers", answerValues: { distributionAssets: ["Email list of 2000 subscribers"] } },
      { field: "capitalAvailability", answerText: "200K raised from angels", answerValues: { capitalAvailability: "$200K raised" } },
      { field: "teamSize", answerText: "Three of us", answerValues: { teamSize: 3 } },
      { field: "geography", answerText: "United States", answerValues: { geography: "United States" } },
    ]);
    const q = nextQuestion(state, {
      expertise: ["Shopify developer", "5 years SaaS"],
      distributionAssets: ["Email list of 2000 subscribers"],
      capitalAvailability: "$200K raised",
      teamSize: 3,
      geography: "United States",
    });
    expect(q.done).toBe(true);
    expect(q.done && !q.terminatedByCap).toBe(true);
  });

  it("trace F: follow-up already used for expertise → moves to distribution", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFollowUpAsked(state, "expertise");
    state = recordFieldAnswer(state, "expertise", "software");
    const profile: FounderProfile = { ...emptyProfile, expertise: ["software"] };
    const q = nextQuestion(state, profile);
    expect(q.done).toBe(false);
    expect(!q.done && q.fieldTarget === "distributionAssets").toBe(true);
    expect(!q.done && !q.isFollowUp).toBe(true);
  });

  it("trace G: expertise+dist+capital asked → teamSize is next", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAsked(state, "distributionAssets");
    state = recordFieldAsked(state, "capitalAvailability");
    const profile: FounderProfile = {
      expertise: ["Shopify app developer with 5 years experience in DTC"],
      distributionAssets: ["Newsletter with 3k subscribers"],
      capitalAvailability: "bootstrapped",
      teamSize: null,
      geography: null,
    };
    const q = nextQuestion(state, profile);
    expect(q.done).toBe(false);
    expect(!q.done && q.fieldTarget === "teamSize").toBe(true);
    expect(!q.done && q.nextQuestion === QUESTIONS.teamSize.opener).toBe(true);
  });

  it("trace H: first 4 asked → geography is next (last in the sequence)", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFieldAsked(state, "distributionAssets");
    state = recordFieldAsked(state, "capitalAvailability");
    state = recordFieldAsked(state, "teamSize");
    const profile: FounderProfile = {
      expertise: ["Shopify app developer with 5 years experience in DTC"],
      distributionAssets: [],
      capitalAvailability: "bootstrapped",
      teamSize: 1,
      geography: null,
    };
    const q = nextQuestion(state, profile);
    expect(q.done).toBe(false);
    expect(!q.done && q.fieldTarget === "geography").toBe(true);
  });

  it("trace I: worst-case question count with all 5 MUST-fill + expertise follow-up = 6, still under cap of 15", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = recordFollowUpAsked(state, "expertise");
    state = recordFieldAsked(state, "distributionAssets");
    state = recordFieldAsked(state, "capitalAvailability");
    state = recordFieldAsked(state, "teamSize");
    state = recordFieldAsked(state, "geography");
    expect(state.questionCount).toBe(6);
    expect(state.questionCount < MAX_QUESTIONS).toBe(true);
    const q = nextQuestion(state, {
      expertise: ["irrelevant"],
      distributionAssets: [],
      capitalAvailability: null,
      teamSize: null,
      geography: null,
    });
    expect(q.done).toBe(true);
  });
});

// ── (4) Cap termination ───────────────────────────────────────────────────────

describe("(4) Cap termination", () => {
  it("questionCount >= MAX_QUESTIONS → done with terminatedByCap=true", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = { ...state, questionCount: MAX_QUESTIONS };
    const q = nextQuestion(state, { ...emptyProfile, expertise: ["software"] });
    expect(q.done).toBe(true);
    expect(q.done && q.terminatedByCap === true).toBe(true);
  });

  it("forceCompleteByCapTermination after cap: coverage complete, unasked fields have capTerminated=true", () => {
    let state = emptyIntakeState();
    state = recordFieldAsked(state, "expertise");
    state = { ...state, questionCount: MAX_QUESTIONS };
    const fixed = forceCompleteByCapTermination(state);
    const cov = checkCoverage(fixed);
    expect(cov.complete).toBe(true);
    expect(
      fixed.fields.distributionAssets.capTerminated &&
        fixed.fields.capitalAvailability.capTerminated &&
        fixed.fields.teamSize.capTerminated &&
        fixed.fields.geography.capTerminated
    ).toBe(true);
    expect(fixed.fields.expertise.capTerminated).toBe(false);
  });

  it("cap fires even when no fields have been asked (pathological case)", () => {
    const state = { ...emptyIntakeState(), questionCount: MAX_QUESTIONS };
    const q = nextQuestion(state, emptyProfile);
    expect(q.done && q.terminatedByCap).toBe(true);
  });
});

// ── (5) Contradiction detection ───────────────────────────────────────────────

describe("(5) Contradiction detection", () => {
  it("solo + team reference → flag detected with correct fields and message", () => {
    const profile: FounderProfile = {
      expertise: ["solopreneur, built several SaaS tools myself"],
      distributionAssets: [],
      capitalAvailability: null,
      teamSize: null,
      geography: null,
    };
    const flag = detectContradiction(
      profile,
      "distributionAssets",
      "my team has built a lot of distribution infrastructure over the years"
    );
    expect(flag).not.toBeNull();
    expect(flag?.field1).toBe("expertise");
    expect(flag?.field2).toBe("distributionAssets");
    expect(flag?.message.toLowerCase().includes("team")).toBe(true);
    expect(flag?.resolved).toBe(false);
  });

  it("bootstrapped + raised → flag detected, message addresses capital/funding", () => {
    const profile: FounderProfile = {
      expertise: ["Shopify developer"],
      distributionAssets: [],
      capitalAvailability: "bootstrapped with personal savings",
      teamSize: null,
      geography: null,
    };
    const flag = detectContradiction(
      profile,
      "capitalAvailability",
      "we raised a $500K seed round last year"
    );
    expect(flag).not.toBeNull();
    expect(flag?.field1).toBe("capitalAvailability");
    expect(
      flag?.message.toLowerCase().includes("capital") === true ||
        flag?.message.toLowerCase().includes("fund") === true
    ).toBe(true);
  });

  it("raised + bootstrapped → flag detected", () => {
    const profile: FounderProfile = {
      expertise: [],
      distributionAssets: [],
      capitalAvailability: "raised $1.2M Series A",
      teamSize: null,
      geography: null,
    };
    const flag = detectContradiction(profile, "capitalAvailability", "I'm fully bootstrapped with no outside capital");
    expect(flag).not.toBeNull();
  });

  it("clean answer → no flag", () => {
    const profile: FounderProfile = {
      expertise: ["Shopify app developer for 6 years"],
      distributionAssets: [],
      capitalAvailability: null,
      teamSize: null,
      geography: null,
    };
    const flag = detectContradiction(
      profile,
      "distributionAssets",
      "I have a newsletter with 3,000 Shopify merchants"
    );
    expect(flag).toBeNull();
  });

  it("empty profile → no flag (nothing to contradict)", () => {
    const flag = detectContradiction(emptyProfile, "expertise", "I have a team of 3 engineers");
    expect(flag).toBeNull();
  });

  it("solo expertise + incoming teamSize answer describing a team → flag detected", () => {
    const profile: FounderProfile = {
      ...emptyProfile,
      expertise: ["solopreneur — built everything myself"],
    };
    const flag = detectContradiction(profile, "teamSize", "It's a team of 5 including me");
    expect(flag).not.toBeNull();
    expect(flag?.field1).toBe("expertise");
    expect(flag?.field2).toBe("teamSize");
  });

  it("solo expertise + teamSize answer '1' → no flag (consistent)", () => {
    const profile: FounderProfile = {
      ...emptyProfile,
      expertise: ["solopreneur"],
    };
    const flag = detectContradiction(profile, "teamSize", "1");
    expect(flag).toBeNull();
  });

  it("geography answer alone → no flag (no rule targets geography)", () => {
    const profile: FounderProfile = {
      ...emptyProfile,
      expertise: ["solopreneur"],
    };
    const flag = detectContradiction(profile, "geography", "United States");
    expect(flag).toBeNull();
  });

  it("addContradictionFlag + resolveContradictionFlag: detected, stored, marked resolved without removal", () => {
    let state = emptyIntakeState();
    const profile: FounderProfile = {
      expertise: ["solopreneur"],
      distributionAssets: [],
      capitalAvailability: null,
      teamSize: null,
      geography: null,
    };
    const flag = detectContradiction(profile, "distributionAssets", "my team runs our outbound campaigns");
    expect(flag).not.toBeNull();
    if (flag) {
      state = addContradictionFlag(state, flag);
      expect(state.contradictionFlags.length).toBe(1);
      expect(state.contradictionFlags[0].resolved).toBe(false);
      state = resolveContradictionFlag(state, 0);
      expect(state.contradictionFlags[0].resolved).toBe(true);
      expect(state.contradictionFlags.length).toBe(1);
    }
  });
});
