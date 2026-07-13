// Compression Agent — deterministic tie-break + gate + venture_score
// (AI_AGENTS.md §11, OPPORTUNITY_ENGINE.md §8). Pure decision logic
// only; the actual promotion transaction (DB writes, exactly-one-
// promotes-edge enforcement) is DATABASE_SCHEMA.md §8's job, not
// this file's — this is just "given scored candidates, which one
// wins and why."
//
// GAP FOUND WHILE WRITING THIS: the documented tie-break sequence
// (venture_score -> confidence_score -> founder_fit_score ->
// distribution_score -> recency -> complexity) never specified what
// happens if a genuine tie survives every single dimension. Since
// "exactly one promotion per run" is a hard invariant elsewhere
// (GRAPH_SCHEMA.md §4.9), leaving that case undefined would be a real
// bug, not a theoretical one. Fixed here with an explicit final
// tiebreaker: lowest candidate id wins. Arbitrary, but deterministic —
// which is the actual requirement (Principle: "Deterministic ordering
// is mandatory," carried over from the earlier NVIDIA-framed draft's
// Tie-Break Protocol, one of the few things adopted from it).
export interface CandidateForCompression {
  id: string;
  opportunityQuality: number; // 0-1, from Scoring Agent
  founderFitScore: number; // 0-100, from FounderFit Agent
  confidenceScore: number; // 0-1, from Confidence Agent
  distributionSubScore: number; // 0-1, the same sub-score Scoring computed
  lastEvidenceSeenAt: Date; // for the recency tiebreak
  operationalComplexityEstimate: number; // 0-1, lower = simpler = wins tiebreak
}

export interface VentureScoreConfig {
  minFounderFitThreshold: number; // default 25 (0-100 scale, OPPORTUNITY_ENGINE.md §8)
  qualityWeight: number; // default 0.7 — still-unvalidated placeholder, OPPORTUNITY_ENGINE.md §13.3
  founderFitWeight: number; // default 0.3
}

export interface VentureScoreResult {
  ventureScore: number | null; // null if gated out
  gated: boolean;
  gateReason?: string;
}

export function computeVentureScore(
  candidate: Pick<CandidateForCompression, "opportunityQuality" | "founderFitScore">,
  config: VentureScoreConfig
): VentureScoreResult {
  if (candidate.founderFitScore < config.minFounderFitThreshold) {
    return { ventureScore: null, gated: true, gateReason: "failed_gate" };
  }
  // opportunityQuality is 0-1, founderFitScore is 0-100 — normalize
  // founderFitScore onto the same 0-1 scale before combining, since
  // OPPORTUNITY_ENGINE.md §8's formula assumes both terms are
  // comparable magnitudes. This normalization wasn't explicit in any
  // prior document either — flagged the same way as scoring.ts.
  const normalizedFounderFit = candidate.founderFitScore / 100;
  const ventureScore = config.qualityWeight * candidate.opportunityQuality + config.founderFitWeight * normalizedFounderFit;
  return { ventureScore, gated: false };
}

export interface CompressionResult {
  winnerId: string | null;
  outcome: "promoted" | "insufficient_evidence";
  trace: string[]; // human-readable log of every tiebreak step actually applied — for agent_execution_log / audit
  deprecated: { id: string; reason: string }[];
}

const MARGIN_THRESHOLD = 5 / 100; // venture_score is 0-1 scale here; "5 points" from the original 0-100 framing becomes 0.05

export function runCompression(
  candidates: CandidateForCompression[],
  config: VentureScoreConfig
): CompressionResult {
  const trace: string[] = [];
  const deprecated: { id: string; reason: string }[] = [];

  const scored = candidates
    .map((c) => ({ candidate: c, score: computeVentureScore(c, config) }))
    .filter((s) => {
      if (s.score.gated) {
        deprecated.push({ id: s.candidate.id, reason: s.score.gateReason! });
        trace.push(`${s.candidate.id}: excluded — ${s.score.gateReason}`);
        return false;
      }
      return true;
    });

  if (scored.length === 0) {
    trace.push("no candidate passed the founder-fit gate — run ends insufficient_evidence");
    return { winnerId: null, outcome: "insufficient_evidence", trace, deprecated };
  }

  // Sort descending by venture_score
  scored.sort((a, b) => b.score.ventureScore! - a.score.ventureScore!);
  trace.push(
    `ranked by venture_score: ${scored.map((s) => `${s.candidate.id}=${s.score.ventureScore!.toFixed(3)}`).join(", ")}`
  );

  let survivors = scored;
  if (survivors.length > 1) {
    const top = survivors[0].score.ventureScore!;
    const second = survivors[1].score.ventureScore!;
    if (top - second > MARGIN_THRESHOLD) {
      trace.push(`margin ${(top - second).toFixed(3)} exceeds threshold ${MARGIN_THRESHOLD} — top candidate wins outright`);
      survivors = [survivors[0]];
    } else {
      trace.push(`margin ${(top - second).toFixed(3)} within threshold — proceeding to tiebreak sequence`);
      // Within-margin ties go through the full sequence: keep every
      // candidate within MARGIN_THRESHOLD of the top score, not just top 2.
      survivors = survivors.filter((s) => top - s.score.ventureScore! <= MARGIN_THRESHOLD);
    }
  }

  const tiebreakSteps: { name: string; better: (a: CandidateForCompression, b: CandidateForCompression) => number }[] = [
    { name: "confidence_score", better: (a, b) => b.confidenceScore - a.confidenceScore },
    { name: "founder_fit_score", better: (a, b) => b.founderFitScore - a.founderFitScore },
    { name: "distribution_score", better: (a, b) => b.distributionSubScore - a.distributionSubScore },
    { name: "recency", better: (a, b) => b.lastEvidenceSeenAt.getTime() - a.lastEvidenceSeenAt.getTime() },
    { name: "complexity (lower wins)", better: (a, b) => a.operationalComplexityEstimate - b.operationalComplexityEstimate },
  ];

  for (const step of tiebreakSteps) {
    if (survivors.length <= 1) break;
    const before = survivors.length;
    const sorted = [...survivors].sort((a, b) => step.better(a.candidate, b.candidate));
    const bestValue = step.better(sorted[0].candidate, sorted[0].candidate); // 0 by construction; compare against sorted[0]
    survivors = sorted.filter((s) => step.better(sorted[0].candidate, s.candidate) === 0);
    trace.push(`tiebreak[${step.name}]: ${before} -> ${survivors.length} candidate(s)`);
  }

  if (survivors.length > 1) {
    // Documented gap, fixed here: final deterministic fallback.
    survivors.sort((a, b) => (a.candidate.id < b.candidate.id ? -1 : 1));
    trace.push(
      `all tiebreak dimensions exhausted with ${survivors.length} still tied — falling back to lowest candidate id (documented fix, see file header)`
    );
    survivors = [survivors[0]];
  }

  const winner = survivors[0].candidate;
  for (const s of scored) {
    if (s.candidate.id !== winner.id) {
      deprecated.push({ id: s.candidate.id, reason: "lost_tiebreak" });
    }
  }

  trace.push(`winner: ${winner.id}`);
  return { winnerId: winner.id, outcome: "promoted", trace, deprecated };
}
