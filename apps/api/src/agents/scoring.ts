// Scoring Agent — deterministic formula only (AI_AGENTS.md §10),
// computes opportunity_quality from the six weighted sub-scores named
// throughout OPPORTUNITY_ENGINE.md/DATABASE_SCHEMA.md's scoring_config
// (w1_demand..w6_timing), reading a frozen scoring_config snapshot.
//
// HONEST FLAG: the six sub-score names (demand/hypothesis/margin/
// feasibility/distribution/timing) were referenced constantly across
// every prior document, but the actual per-sub-score arithmetic was
// never specified anywhere — this file is the first time it's been
// written down concretely. The mappings below are a defensible first
// pass grounded in the fields that actually exist on Market/Audience/
// Problem/Hypothesis/BusinessModel (DATABASE_SCHEMA.md §3), not an
// existing spec being transcribed. Treat these formulas the same way
// scoring_config's w1..w6 weights are already treated — a tunable,
// versioned starting point (v3 §9's Phase 1/heuristic framing), not a
// validated model.
//
// COMPOSED BusinessModel is a competitive benchmark, not the
// entrant's own plan (AI_AGENTS.md §8 semantics note). All BM-derived
// sub-scores below are read under that framing:
//   * margin = the market's margin structure that a new entrant would
//     be benchmarked against — high competitor margins signal room
//     for the entrant to capture some; low competitor margins signal
//     a commoditized surface with less room to price.
//   * feasibility = the entry cost / build effort a new entrant faces
//     to replicate a comparable offering against this benchmark. Low
//     competitor operational_complexity/capital_intensity implies
//     low replication cost = high feasibility for a new entrant to
//     even attempt to build. (The related "low barrier → more
//     competition" concern is a demand-side signal in a different
//     sub-score, not a feasibility one.)
// Formula is unchanged from the pre-framing pass — under either
// reading the directional signal for opportunity_quality is the
// same, only the phrasing shifts.
export interface ScoringConfigWeights {
  w1Demand: number;
  w2Hypothesis: number;
  w3Margin: number;
  w4Feasibility: number;
  w5Distribution: number;
  w6Timing: number;
}

export interface ScoringInputs {
  market: {
    growthRateEstimate: number | null; // decimal, e.g. 0.15 = 15% — assumed range roughly -0.3 to 0.5
    maturityStage: "emerging" | "growing" | "mature" | "declining";
  };
  audience: {
    willingnessToPaySignal: number | null; // 0-1, already normalized per schema
    acquisitionChannelsKnown: string[];
  };
  problem: {
    severitySignal: number | null; // 0-1
    frequencySignal: number | null; // 0-1
  };
  hypothesis: {
    validationScore: number | null; // 0-1 (Confidence Agent's output, AI_AGENTS.md §7)
    // 0-1. Deterministic tier-weighted evidence-authority × distinct-source-count
    // metric, computed by agents/evidenceStrength.ts at hypothesis-creation time.
    // Deliberately distinct signal from validationScore (which is banded + gated
    // by the LLM's semantic answers_question judgment). Fixed P3.1: this used to
    // hold the LLM's self-reported hypothesis confidence, an ungrounded value
    // that corrupted the hypothesis sub-score.
    supportingEvidenceStrength: number | null;
  };
  businessModel: {
    marginProfile: number | null; // 0-1
    operationalComplexityEstimate: number | null; // 0-1, higher = more complex
    capitalIntensityEstimate: number | null; // 0-1, higher = more capital required
  };
}

export interface ScoringOutput {
  opportunityQuality: number;
  subScores: {
    demand: number;
    hypothesis: number;
    margin: number;
    feasibility: number;
    distribution: number;
    timing: number;
  };
  // Per-field provenance for the seven inputs Scoring reads that
  // COULD be null under the current schema. Five of them fall back to
  // a neutral default (chronic-null coverage gap — see the P1.1/P2.1
  // investigation); two of them (validationScore, supportingEvidenceStrength)
  // are asserted non-null and always "real" here. Purely observability —
  // NOT blended into opportunityQuality. Same discipline as the JSON-
  // repair fix's repaired/retried fields and confidenceMode2's
  // freshnessSources[].
  scoringInputProvenance: ScoringInputProvenance[];
  // Aggregate counts across the seven tracked fields — cheap for
  // callers/audit logs to read without re-scanning per-field.
  // realInputCount + defaultedInputCount === 7 by construction.
  realInputCount: number;
  defaultedInputCount: number;
}

export interface ScoringInputProvenance {
  field:
    | "growthRateEstimate"
    | "willingnessToPaySignal"
    | "validationScore"
    | "supportingEvidenceStrength"
    | "marginProfile"
    | "operationalComplexityEstimate"
    | "capitalIntensityEstimate";
  source: "real" | "default";
  // Value actually consumed by the formula — the real value when
  // source='real', the default constant when source='default'. Kept
  // in a consistent 0-1 shape where the field is already 0-1; for
  // growthRateEstimate this is the RAW input value (not the
  // normalized one) so auditors can compare against the source data.
  value: number;
}

const NEUTRAL_DEFAULT = 0.5; // used when a signal is null — a missing signal is a coverage/confidence
// problem (Confidence Agent's job, AI_AGENTS.md §7), not something Scoring should silently
// punish or reward by treating null as 0.

// growthRateEstimate uses a separate raw-space default (0.1) that
// normalizes onto NEUTRAL_DEFAULT in the demand sub-score: the raw
// range is [-0.3, 0.5] and normalize(0.1, -0.3, 0.5) = 0.5. Kept as
// its own constant so a future range change doesn't silently break
// the numerical equivalence.
const GROWTH_RATE_RAW_DEFAULT = 0.1;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Maps a value from an arbitrary [min, max] range onto [0, 1], clamped.
function normalize(value: number, min: number, max: number): number {
  return clamp01((value - min) / (max - min));
}

const MATURITY_STAGE_TIMING_SCORE: Record<ScoringInputs["market"]["maturityStage"], number> = {
  emerging: 0.9,
  growing: 0.75,
  mature: 0.4,
  declining: 0.15,
};

export function computeOpportunityQuality(inputs: ScoringInputs, weights: ScoringConfigWeights): ScoringOutput {
  // ---- Hard-asserted inputs (P1.1/P2.1: category 2) ----
  // These two fields cannot legitimately reach Scoring with a null
  // value under the current pipeline:
  //   * validationScore is gated at Composition
  //     (compositionAgent.ts's `validation_score !== null AND >= 0.5`
  //     precondition — a null hypothesis never gets a candidate row).
  //   * supportingEvidenceStrength is always populated at hypothesis
  //     creation time by hypothesisAgent.ts:111-116, using
  //     evidenceStrength.ts's computeSupportingEvidenceStrength() —
  //     which returns 0 (not null) for zero-evidence input.
  // A null here is therefore an invariant violation upstream, not a
  // coverage gap — throw loud so the failure points at the right
  // subsystem instead of silently coalescing to a 0.5 default that
  // would corrupt the hypothesis sub-score without leaving a trace.
  if (inputs.hypothesis.validationScore === null) {
    throw new Error(
      "Scoring received null hypothesis.validationScore — Composition's " +
        "`validation_score !== null AND >= 0.5` gate (compositionAgent.ts:57) " +
        "should have prevented this candidate from being created. Investigate " +
        "any code path that inserts opportunity_candidate_composition rows " +
        "without going through runCompositionAgent."
    );
  }
  if (inputs.hypothesis.supportingEvidenceStrength === null) {
    throw new Error(
      "Scoring received null hypothesis.supportingEvidenceStrength — Hypothesis " +
        "Agent's always-computes contract (hypothesisAgent.ts:111-116 + " +
        "evidenceStrength.ts::computeSupportingEvidenceStrength, which returns " +
        "0 not null for zero-evidence input) should have prevented this. " +
        "Investigate any code path that inserts hypothesis rows outside " +
        "hypothesisRepository.create."
    );
  }
  const validationScore = inputs.hypothesis.validationScore;
  const supportingEvidenceStrength = inputs.hypothesis.supportingEvidenceStrength;

  // ---- Chronic-null inputs (P1.1/P2.1: category 1) ----
  // These five fields have no current write path in Data Pipeline —
  // see the P1.1/P2.1 investigation. Keep the neutral default (score
  // is byte-identical to pre-fix by design) but record per-field that
  // the default was used, so downstream — rationale, audit logs — can
  // truthfully say how much of the score is grounded vs padded.
  const provenance: ScoringInputProvenance[] = [];

  const growthRateReal = inputs.market.growthRateEstimate;
  const growthRateValue = growthRateReal ?? GROWTH_RATE_RAW_DEFAULT;
  provenance.push({
    field: "growthRateEstimate",
    source: growthRateReal === null ? "default" : "real",
    value: growthRateValue,
  });

  const willingnessReal = inputs.audience.willingnessToPaySignal;
  const willingnessValue = willingnessReal ?? NEUTRAL_DEFAULT;
  provenance.push({
    field: "willingnessToPaySignal",
    source: willingnessReal === null ? "default" : "real",
    value: willingnessValue,
  });

  // Hard-asserted pair — always "real" by the time we get here.
  provenance.push({ field: "validationScore", source: "real", value: validationScore });
  provenance.push({
    field: "supportingEvidenceStrength",
    source: "real",
    value: supportingEvidenceStrength,
  });

  const marginReal = inputs.businessModel.marginProfile;
  const marginValue = marginReal ?? NEUTRAL_DEFAULT;
  provenance.push({
    field: "marginProfile",
    source: marginReal === null ? "default" : "real",
    value: marginValue,
  });

  const opComplexityReal = inputs.businessModel.operationalComplexityEstimate;
  const opComplexityValue = opComplexityReal ?? NEUTRAL_DEFAULT;
  provenance.push({
    field: "operationalComplexityEstimate",
    source: opComplexityReal === null ? "default" : "real",
    value: opComplexityValue,
  });

  const capitalReal = inputs.businessModel.capitalIntensityEstimate;
  const capitalValue = capitalReal ?? NEUTRAL_DEFAULT;
  provenance.push({
    field: "capitalIntensityEstimate",
    source: capitalReal === null ? "default" : "real",
    value: capitalValue,
  });

  // ---- Sub-score formulas — unchanged numerically. ----
  const demand = (normalize(growthRateValue, -0.3, 0.5) + willingnessValue) / 2;
  const hypothesis = (validationScore + supportingEvidenceStrength) / 2;
  // margin: the composed BM's marginProfile is the COMPETITOR's — read
  // as the market's margin structure that an entrant would be
  // benchmarked against, not the entrant's own margin plan.
  const margin = marginValue;
  // feasibility: read the competitor's operational_complexity and
  // capital_intensity as the entry cost / build effort a new
  // entrant faces to replicate a comparable offering. Low → cheap
  // to enter (high feasibility). High → deep moat (low feasibility).
  const feasibility = 1 - (opComplexityValue + capitalValue) / 2;
  // Heuristic: 3+ known acquisition channels = max distribution score.
  // Flagged the same way as everything else in this file — a starting
  // point, not a validated threshold.
  const distribution = clamp01(inputs.audience.acquisitionChannelsKnown.length / 3);
  const timing = MATURITY_STAGE_TIMING_SCORE[inputs.market.maturityStage];

  const opportunityQuality =
    weights.w1Demand * demand +
    weights.w2Hypothesis * hypothesis +
    weights.w3Margin * margin +
    weights.w4Feasibility * feasibility +
    weights.w5Distribution * distribution +
    weights.w6Timing * timing;

  const defaultedInputCount = provenance.filter((p) => p.source === "default").length;
  const realInputCount = provenance.length - defaultedInputCount;

  return {
    opportunityQuality: clamp01(opportunityQuality),
    subScores: { demand, hypothesis, margin, feasibility, distribution, timing },
    scoringInputProvenance: provenance,
    realInputCount,
    defaultedInputCount,
  };
}
