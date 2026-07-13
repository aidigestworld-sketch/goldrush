// Founder Intake Engine — core types and pure state-transition functions.
//
// Everything here is a pure function over immutable FounderIntakeState
// objects — no DB reads, no side effects. The live wrapper (future task)
// will load state from founder.intake_state (jsonb), call these functions,
// and persist the result. This mirrors the "logic first, live wrapper
// after" pattern used for Confidence Mode 2.
//
// Key invariant (mirrors the P1.1/P1.2/P1.3/capitalAvailability fixes):
//   asked=true  with value=[]/"" → founder was asked and genuinely
//               has nothing to report — valid, complete answer.
//   asked=false with value=[]/"" → field was never asked — missing
//               data, not an empty answer.
// Without this distinction the system conflates "no distribution assets"
// with "never asked about distribution", which silently starves FounderFit
// of signal it needs.

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type MustFillField = "expertise" | "distributionAssets" | "capitalAvailability";

export const MUST_FILL_FIELDS: readonly MustFillField[] = [
  "expertise",
  "distributionAssets",
  "capitalAvailability",
];

// Depth is observability-only — does NOT gate completion (same discipline
// as scoringInputProvenance/freshnessSources). Kept alongside the
// intake record so the eventual rationale generator can report "founder
// gave a 3-word answer" vs "gave a 40-word specific answer" without
// needing to re-derive it from the stored field value.
export interface FieldDepth {
  wordCount: number;
}

export interface FieldIntakeRecord {
  asked: boolean;
  askedAt: string | null;   // ISO 8601, null if not yet asked
  // true if this field was force-completed by the question cap rather than
  // a real response — caller should treat the stored field value as absent,
  // not as a legitimate empty answer.
  capTerminated: boolean;
  // Whether a follow-up / clarifying question for this field has already
  // been issued. Used by the sequencer to prevent asking multiple
  // follow-ups for the same field within a single session.
  followUpAsked: boolean;
  depth: FieldDepth | null; // null until the field receives its first answer
}

export interface ContradictionFlag {
  detectedAt: string;           // ISO 8601
  field1: MustFillField;
  snippet1: string;             // excerpt of the earlier answer that triggered the flag
  field2: MustFillField;
  snippet2: string;             // excerpt of the new answer that contradicts it
  message: string;
  resolved: boolean;            // set true after a clarifying follow-up resolves it
}

export interface FounderIntakeState {
  fields: Record<MustFillField, FieldIntakeRecord>;
  questionCount: number;
  completedAt: string | null;   // ISO 8601, null until all MUST-fill fields asked
  contradictionFlags: ContradictionFlag[];
}

// The current profile values — passed separately from the intake state
// because they live on the founder table's own columns (expertise[],
// distributionAssets[], capitalAvailability?), not inside the jsonb blob.
export interface FounderProfile {
  expertise: string[];
  distributionAssets: string[];
  capitalAvailability: string | null;
}

export interface CoverageResult {
  complete: boolean;
  remainingFields: MustFillField[];
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

export const MAX_QUESTIONS = 15;

// ──────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────

function emptyField(): FieldIntakeRecord {
  return { asked: false, askedAt: null, capTerminated: false, followUpAsked: false, depth: null };
}

export function emptyIntakeState(): FounderIntakeState {
  return {
    fields: {
      expertise: emptyField(),
      distributionAssets: emptyField(),
      capitalAvailability: emptyField(),
    },
    questionCount: 0,
    completedAt: null,
    contradictionFlags: [],
  };
}

// ──────────────────────────────────────────────────────────────────────
// Step 2 — Coverage / completion check
// ──────────────────────────────────────────────────────────────────────

// Complete when ALL 3 MUST-fill fields have asked=true, regardless of
// whether their values are populated or empty. A genuinely empty answer
// is still a real answer — do not require non-empty values.
export function checkCoverage(state: FounderIntakeState): CoverageResult {
  const remainingFields = MUST_FILL_FIELDS.filter((f) => !state.fields[f].asked);
  return {
    complete: remainingFields.length === 0,
    remainingFields: remainingFields as MustFillField[],
  };
}

// ──────────────────────────────────────────────────────────────────────
// Step 1 / Step 3 — State-transition helpers
// ──────────────────────────────────────────────────────────────────────

// Mark a MUST-fill field as having been asked. Increments questionCount.
export function recordFieldAsked(
  state: FounderIntakeState,
  field: MustFillField,
  now: Date = new Date()
): FounderIntakeState {
  return {
    ...state,
    questionCount: state.questionCount + 1,
    fields: {
      ...state.fields,
      [field]: {
        ...state.fields[field],
        asked: true,
        askedAt: now.toISOString(),
      },
    },
  };
}

// Mark a follow-up question for a field as asked. Increments questionCount
// but does NOT change asked/askedAt (the primary question already set those).
export function recordFollowUpAsked(
  state: FounderIntakeState,
  field: MustFillField
): FounderIntakeState {
  return {
    ...state,
    questionCount: state.questionCount + 1,
    fields: {
      ...state.fields,
      [field]: {
        ...state.fields[field],
        followUpAsked: true,
      },
    },
  };
}

// Record an answer for a MUST-fill field: compute and store depth signal.
// Does NOT mutate asked/askedAt — those are set at question-ask time.
// answerText is the raw text of the founder's response (used for depth
// only — the actual parsed value is stored on the founder table's own
// columns by the caller).
export function recordFieldAnswer(
  state: FounderIntakeState,
  field: MustFillField,
  answerText: string
): FounderIntakeState {
  const words = answerText.trim().split(/\s+/).filter((w) => w.length > 0);
  return {
    ...state,
    fields: {
      ...state.fields,
      [field]: {
        ...state.fields[field],
        depth: { wordCount: words.length },
      },
    },
  };
}

// Force-complete all still-unasked MUST-fill fields because the question
// cap was hit. Sets asked=true and capTerminated=true on each unasked
// field, and sets completedAt. The caller stores empty values for those
// fields on the founder row — they are NOT treated as legitimate empty
// answers downstream (capTerminated=true is the signal to distinguish them).
export function forceCompleteByCapTermination(
  state: FounderIntakeState,
  now: Date = new Date()
): FounderIntakeState {
  const nowIso = now.toISOString();
  const updatedFields = { ...state.fields };
  for (const f of MUST_FILL_FIELDS) {
    if (!updatedFields[f].asked) {
      updatedFields[f] = {
        ...updatedFields[f],
        asked: true,
        askedAt: nowIso,
        capTerminated: true,
      };
    }
  }
  return {
    ...state,
    fields: updatedFields,
    completedAt: state.completedAt ?? nowIso,
  };
}

// Mark the intake as normally completed (all fields answered, cap not hit).
export function markIntakeComplete(
  state: FounderIntakeState,
  now: Date = new Date()
): FounderIntakeState {
  return { ...state, completedAt: state.completedAt ?? now.toISOString() };
}

// ──────────────────────────────────────────────────────────────────────
// Step 5 — Contradiction detection
// ──────────────────────────────────────────────────────────────────────
//
// Lightweight rule-based check against already-collected profile fields.
// This is NOT evidence-grounding machinery — founder self-report is the
// only source. We flag direct textual contradictions so the sequencer
// can issue a clarifying follow-up rather than silently overwriting.
//
// Called after every answer is recorded; returns a ContradictionFlag if
// a contradiction is detected, or null otherwise.

interface ContradictionRule {
  existingField: MustFillField;
  existingMatch: RegExp;
  incomingField: MustFillField | null; // null = any field
  incomingMatch: RegExp;
  message: string;
}

const CONTRADICTION_RULES: ContradictionRule[] = [
  // Solo operation claimed, then team/co-founder referenced
  {
    existingField: "expertise",
    existingMatch: /\bsolo(?:preneur)?\b|\bjust me\b|\bI'?m the only\b/i,
    incomingField: null,
    incomingMatch: /\bmy (?:team|engineers?|developers?|co-?founders?)\b|\bour team\b|\bwe (?:built|have|run)\b/i,
    message:
      "Earlier answer indicates solo operation; later answer references a team or co-founder — please clarify team composition.",
  },
  // Bootstrapped/no capital, then external funding referenced
  {
    existingField: "capitalAvailability",
    existingMatch: /\bbootstrap(?:ped|ping)?\b|\bno (?:funding|capital|investment|investors)\b|\$0\b|\bself-?funded\b/i,
    incomingField: null,
    incomingMatch: /\braised\b|\binvestors?\b|\bVC\b|\bventure\b|\bseed (?:round|funding)\b|\bSeries [A-D]\b/i,
    message:
      "Capital availability was noted as bootstrapped/self-funded; later answer mentions external funding — please clarify.",
  },
  // External funding claimed, then bootstrapped referenced
  {
    existingField: "capitalAvailability",
    existingMatch: /\braised\b|\binvestors?\b|\bVC\b|\bSeries [A-D]\b|\bseed round\b/i,
    incomingField: null,
    incomingMatch: /\bbootstrap(?:ped|ping)?\b|\bno (?:funding|capital|investment)\b|\bself-?funded\b/i,
    message:
      "Capital availability was noted as externally funded; later answer indicates bootstrapped/self-funded — please clarify.",
  },
];

// Check a new answer for any field against the existing profile for
// contradictions. Returns the first matching flag, or null.
// - existingProfile: the current committed values on the founder row
// - newField: which field the new answer is for
// - newAnswerText: raw text of the new answer
export function detectContradiction(
  existingProfile: FounderProfile,
  newField: MustFillField,
  newAnswerText: string
): ContradictionFlag | null {
  const now = new Date().toISOString();

  // Compile existing field values to match against rules
  const profileText: Record<MustFillField, string> = {
    expertise: existingProfile.expertise.join(" "),
    distributionAssets: existingProfile.distributionAssets.join(" "),
    capitalAvailability: existingProfile.capitalAvailability ?? "",
  };

  for (const rule of CONTRADICTION_RULES) {
    // Skip rules whose incomingField doesn't match this answer
    if (rule.incomingField !== null && rule.incomingField !== newField) continue;

    const existingText = profileText[rule.existingField];
    if (!existingText) continue;
    if (!rule.existingMatch.test(existingText)) continue;
    if (!rule.incomingMatch.test(newAnswerText)) continue;

    return {
      detectedAt: now,
      field1: rule.existingField,
      snippet1: existingText.slice(0, 80),
      field2: newField,
      snippet2: newAnswerText.slice(0, 80),
      message: rule.message,
      resolved: false,
    };
  }

  return null;
}

// Add a detected contradiction flag to the state.
export function addContradictionFlag(
  state: FounderIntakeState,
  flag: ContradictionFlag
): FounderIntakeState {
  return {
    ...state,
    contradictionFlags: [...state.contradictionFlags, flag],
  };
}

// Mark a contradiction flag as resolved (after a clarifying follow-up).
export function resolveContradictionFlag(
  state: FounderIntakeState,
  index: number
): FounderIntakeState {
  const flags = state.contradictionFlags.map((f, i) =>
    i === index ? { ...f, resolved: true } : f
  );
  return { ...state, contradictionFlags: flags };
}
