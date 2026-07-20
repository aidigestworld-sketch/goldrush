// Founder Intake Engine — question-sequencing state machine.
//
// Pure function: given current FounderIntakeState + profile values,
// returns the next question to ask or signals completion. No DB access,
// no LLM calls, no side effects.
//
// BRANCHING DESIGN
// ────────────────
// Primary sequence:
//   expertise → distributionAssets → capitalAvailability → teamSize → geography
// This ordering reflects relative signal weight for FounderFit:
//   1. expertise — most differentiated, drives matched_strength and gap
//      scoring most directly; ask first so subsequent questions can
//      reference it ("given your [X] background, do you have any…")
//   2. distributionAssets — the second source_field FounderFit can cite;
//      asking before capital lets us frame distribution gaps accurately
//   3. capitalAvailability — sensitive question; warm founders up with
//      non-financial questions first
//   4. teamSize — after capital because capital answer often already
//      reveals whether the founder is solo/team-backed
//   5. geography — asked last; least sensitive, cheapest to answer,
//      pads the tail so a founder abandoning mid-flow still gets the
//      four higher-signal fields
//
// Follow-up rule for expertise (only field with a follow-up):
//   If expertise was asked but the answer looks generic/shallow
//   (< 5 words total, OR the array is empty, OR the words are a known
//   vague opener like "software" / "tech" / "business" without
//   modifiers), issue one clarifying follow-up. This never gates
//   progression — it's a depth-improvement step, not a blocker.
//   The follow-up is only ever issued once per session (followUpAsked
//   guards against repetition).
//
// Hard cap: MAX_QUESTIONS (15). Kept at 15 despite the MUST-fill set
// growing 3→5: worst case is now 5 MUST-fill + 1 expertise follow-up
// = 6 questions, still comfortably below the cap. Raising the cap
// would silently trade completion rate for more depth without a
// signal we're leaving on the table — don't do it without evidence.
// On hitting the cap, the sequencer returns `done: true,
// terminatedByCap: true`. The caller must then run
// forceCompleteByCapTermination() from founderIntakeState.ts to
// mark unasked fields and store the state.
//
// SIDE-EFFECT CONTRACT:
// The sequencer returns a result describing what to do next but does NOT
// mutate state. The caller must call:
//   recordFieldAsked() before presenting the returned question
//   recordFollowUpAsked() before presenting a follow-up question
// and persist the updated state to the DB.

import {
  type FounderIntakeState,
  type FounderProfile,
  type MustFillField,
  MAX_QUESTIONS,
  checkCoverage,
} from "./founderIntakeState";

// ──────────────────────────────────────────────────────────────────────
// Question templates
// ──────────────────────────────────────────────────────────────────────

export const QUESTIONS = {
  expertise: {
    opener:
      "What's your professional background — what have you spent the most time doing professionally?",
    followUp:
      "To sharpen the picture: is that background more on the technical side (engineering, product, building) or the go-to-market side (sales, marketing, distribution, operations)?",
  },
  distributionAssets: {
    opener:
      "Do you have any existing channels to reach potential customers? For example: an email list, a community you run, a professional network in a specific industry, or an existing audience.",
  },
  capitalAvailability: {
    opener:
      "What's your current capital situation — are you bootstrapping with personal savings, have you raised external funding, or is that still being figured out?",
  },
  teamSize: {
    opener:
      "Who is working on this with you? Are you solo, or do you have co-founders / employees / regular contractors? A rough head count is fine.",
  },
  geography: {
    opener:
      "Where are you and your team based? A country or region is enough — this helps size which markets you can realistically operate in.",
  },
} as const;

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type SequencerResult =
  | {
      done: true;
      terminatedByCap: boolean;
    }
  | {
      done: false;
      nextQuestion: string;
      fieldTarget: MustFillField;
      isFollowUp: boolean;
    };

// ──────────────────────────────────────────────────────────────────────
// Expertise follow-up heuristic
// ──────────────────────────────────────────────────────────────────────

// Single-word or very-short vague openers that warrant a follow-up.
const VAGUE_EXPERTISE_TOKENS = new Set([
  "software",
  "tech",
  "technology",
  "business",
  "it",
  "engineering",
  "developer",
  "development",
  "management",
  "consulting",
  "finance",
]);

function expertiseNeedsFollowUp(profile: FounderProfile): boolean {
  if (profile.expertise.length === 0) return true;
  const allText = profile.expertise.join(" ").trim();
  const words = allText.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 5) return true;
  // All tokens are vague-generic (no specific domain terms) → follow-up
  const meaningful = words.filter((w) => !VAGUE_EXPERTISE_TOKENS.has(w.toLowerCase()));
  return meaningful.length === 0;
}

// ──────────────────────────────────────────────────────────────────────
// Main sequencer
// ──────────────────────────────────────────────────────────────────────

export function nextQuestion(
  state: FounderIntakeState,
  profile: FounderProfile
): SequencerResult {
  // Cap check: if we've hit or exceeded MAX_QUESTIONS, signal cap
  // termination. Caller must run forceCompleteByCapTermination().
  if (state.questionCount >= MAX_QUESTIONS) {
    return { done: true, terminatedByCap: true };
  }

  // Coverage check: if all MUST-fill fields are asked, intake is done.
  const coverage = checkCoverage(state);
  if (coverage.complete) {
    return { done: true, terminatedByCap: false };
  }

  const exp = state.fields.expertise;
  const dist = state.fields.distributionAssets;
  const cap = state.fields.capitalAvailability;
  const team = state.fields.teamSize;
  const geo = state.fields.geography;

  // 1. Expertise opener — always first
  if (!exp.asked) {
    return {
      done: false,
      nextQuestion: QUESTIONS.expertise.opener,
      fieldTarget: "expertise",
      isFollowUp: false,
    };
  }

  // 2. Expertise follow-up — one per session, only if still under cap and
  //    not yet issued, and answer was shallow/vague
  if (
    exp.asked &&
    !exp.followUpAsked &&
    !exp.capTerminated &&
    state.questionCount < MAX_QUESTIONS &&
    expertiseNeedsFollowUp(profile)
  ) {
    return {
      done: false,
      nextQuestion: QUESTIONS.expertise.followUp,
      fieldTarget: "expertise",
      isFollowUp: true,
    };
  }

  // 3. Distribution assets
  if (!dist.asked) {
    return {
      done: false,
      nextQuestion: QUESTIONS.distributionAssets.opener,
      fieldTarget: "distributionAssets",
      isFollowUp: false,
    };
  }

  // 4. Capital availability
  if (!cap.asked) {
    return {
      done: false,
      nextQuestion: QUESTIONS.capitalAvailability.opener,
      fieldTarget: "capitalAvailability",
      isFollowUp: false,
    };
  }

  // 5. Team size
  if (!team.asked) {
    return {
      done: false,
      nextQuestion: QUESTIONS.teamSize.opener,
      fieldTarget: "teamSize",
      isFollowUp: false,
    };
  }

  // 6. Geography
  if (!geo.asked) {
    return {
      done: false,
      nextQuestion: QUESTIONS.geography.opener,
      fieldTarget: "geography",
      isFollowUp: false,
    };
  }

  // All asked — complete (coverage.complete would have caught this above,
  // but explicit guard here is defensive)
  return { done: true, terminatedByCap: false };
}
