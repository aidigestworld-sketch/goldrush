// Real Compression Agent — DAG stage 11 (the join). AI_AGENTS.md §11.
// Deterministic (no LLM call for tie-break itself — the rationale/
// risk phrasing sub-step is deferred to a separate, follow-up
// transaction per DAG §3's exception note).
//
// This wrapper is the fork-JOIN: it waits for both 10a (Confidence
// Mode 2) and 10b (FounderFit) to have committed on every candidate
// in the run before it will proceed. On manual-runner invocation
// (this task's scope), the wait is a polling readiness check — if
// any candidate is missing either branch, the wrapper returns a
// clear "not_ready" without touching anything. Phase 6's Orchestrator
// replaces this poll with a real BullMQ flow-dependency, but the
// underlying readiness contract stays identical.
//
// PROMOTION TRANSACTION (DATABASE_SCHEMA.md §8): once all branches
// are ready and the pure Compression function has picked a winner,
// this wrapper issues ONE $transaction that:
//   1. UPDATE opportunity_candidate SET status='promoted' WHERE id=winner AND status='candidate'
//   2. UPDATE opportunity_candidate SET status='deprecated', deprecation_reason=... WHERE id ANY(losers)
//   3. INSERT INTO opportunity (promoted_from_candidate_id, venture_score, confidence_score,
//                                founder_fit_score, founder_fit_rationale, rationale_bullets, risk_summary)
//   4. INSERT INTO edge (edge_type='promotes', from_id=winner, to_id=new_opportunity)
//   5. UPDATE pipeline_run SET current_stage='completed', status=<terminal>, completed_at=now()
//
// rationale_bullets/risk_summary are inserted as empty arrays here.
// The LLM-based phrasing step (DAG §3's exception) will land those
// in a SEPARATE, smaller transaction later — that transaction only
// UPDATEs the already-created opportunity.rationale_bullets/
// risk_summary columns, keeping the promotion transaction itself
// short (no LLM call held under row locks).
//
// The `AND status='candidate'` guard on the promoted-winner UPDATE is
// the cheap optimistic-concurrency check §8 specifies: if some other
// process already promoted or deprecated this candidate between our
// read and our write, the UPDATE affects zero rows and we abort.
//
// AUTO-DEPRECATION of incomplete-composition candidates: candidates
// whose Confidence Mode 2 committed `incomplete_composition=TRUE`
// have NULL confidence_score, so they can't feed into the pure
// Compression function's tie-break. This wrapper deprecates them
// with reason 'incomplete_composition' as part of the promotion
// transaction — Compression sees them as auto-losers.
//
// DEPENDENCY on Scoring's sub-scores: the pure Compression function
// requires distribution_sub_score as a tie-break dimension, but only
// opportunity_quality (the aggregate) is persisted on opportunity_candidate.
// This wrapper re-derives the sub-scores by re-running Scoring's
// deterministic pure function against the composed graph — same inputs
// → same outputs, so this isn't duplicate work, it's using the pure
// function as the source of truth for a derived signal that has no
// dedicated column yet. If a future migration persists distribution
// (or all sub-scores) on opportunity_candidate, this re-derive step
// collapses into a straight DB read.
import { runCompression, type CandidateForCompression, type VentureScoreConfig } from "../compression";
import { computeOpportunityQuality, type ScoringInputs, type ScoringInputProvenance } from "../scoring";
import { scoringConfigRepository } from "../../repositories/scoringConfig.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";
import { computeMaxEvidenceRecency } from "./compressionRecency";

// OPPORTUNITY_ENGINE.md §8 defaults — same numbers used across the
// pure Compression tests and the Compression header comment.
export const DEFAULT_MIN_FOUNDER_FIT_THRESHOLD = 25;
export const DEFAULT_QUALITY_WEIGHT = 0.7;
export const DEFAULT_FOUNDER_FIT_WEIGHT = 0.3;

export interface CompressionRunResult {
  // Not-ready path — returned WITHOUT touching any row.
  notReady: boolean;
  notReadyDetails?: {
    missingMode2: string[]; // candidate ids
    missingFounderFit: string[]; // candidate ids
  };
  // Ready + ran path.
  outcome?: "promoted" | "insufficient_evidence";
  winnerId?: string | null;
  createdOpportunityId?: string | null;
  deprecated?: { id: string; reason: string }[];
  incompleteCompositionDeprecated?: string[]; // candidates auto-deprecated for gate-failure
  trace?: string[];
  ventureScoresById?: { id: string; ventureScore: number | null; gated: boolean }[];
  // Per-candidate recency-tiebreak provenance (P3.2). For each
  // candidate that reached the tie-break pool, records which
  // timestamp source drove its lastEvidenceSeenAt and how many of
  // its cited evidence rows had a real sourcePublishedAt versus
  // falling back to fetchedAt. Kept SEPARATELY from the aggregate
  // trace so operators can audit which promotion decisions are
  // grounded in real source dates vs the ingest-time fallback —
  // the same observability discipline used for the JSON-repair
  // repaired/retried fields.
  recencyProvenanceByCandidateId?: {
    id: string;
    maxUsedTimestamp: "source_published_at" | "fetched_at_fallback" | "candidate_created_at_fallback" | "empty";
    sourcePublishedCount: number;
    fetchedAtFallbackCount: number;
  }[];
  // Per-candidate tiebreak-input provenance (P1.3). Mirrors scoring.ts's
  // ScoringInputProvenance shape/naming so the two observability streams
  // read consistently. Currently only tracks operationalComplexityEstimate
  // — the only chronic-null tiebreak dimension deriveTiebreakDimensions
  // silently defaults (0.5) when the composed business_model row is
  // missing the field. Same category-1 treatment as scoring.ts's five
  // chronic-null fields: keep the default (byte-identical tiebreak
  // decision), but flag when the default was used so audit logs /
  // rationale can distinguish real signal from padding.
  tiebreakInputProvenanceByCandidateId?: {
    id: string;
    provenance: ScoringInputProvenance[];
  }[];
}

export async function runCompressionAgent(
  runId: string,
  options: {
    minFounderFitThreshold?: number;
    qualityWeight?: number;
    founderFitWeight?: number;
  } = {}
): Promise<CompressionRunResult> {
  const run = await prisma.pipelineRun.findUnique({ where: { runId } });
  if (!run) {
    throw new Error(`pipeline_run ${runId} not found`);
  }

  const candidates = await prisma.opportunityCandidate.findMany({
    where: { runId, status: "candidate" },
  });
  if (candidates.length === 0) {
    // Genuine "nothing to compress" case — no candidate ever reached
    // Composition. Same terminal state as pure Compression's
    // insufficient_evidence outcome, without the pure function needing
    // to be called (it would receive an empty list).
    return await terminalCommit(runId, {
      outcome: "insufficient_evidence",
      trace: ["no candidates with status='candidate' for this run — insufficient_evidence"],
      winnerId: null,
      deprecated: [],
      incompleteCompositionDeprecated: [],
    });
  }

  // 10a + 10b readiness check. Both branches "reporting" is the
  // signal to proceed — for 10a, `confidence_coverage_gate` being
  // non-null means the wrapper committed a result (TRUE or FALSE).
  // For 10b, `founder_fit_score` being non-null is the signal.
  // Note: opportunity_quality being null is a Scoring-not-done
  // upstream problem, not a fork-branch issue — check both anyway
  // so the runner catches it here rather than crashing later.
  const missingMode2 = candidates
    .filter((c) => c.confidenceCoverageGate === null)
    .map((c) => c.id);
  const missingFounderFit = candidates
    .filter((c) => c.founderFitScore === null)
    .map((c) => c.id);
  const missingScoring = candidates.filter((c) => c.opportunityQuality === null).map((c) => c.id);

  if (missingMode2.length > 0 || missingFounderFit.length > 0 || missingScoring.length > 0) {
    return {
      notReady: true,
      notReadyDetails: {
        missingMode2,
        missingFounderFit: [...missingFounderFit, ...missingScoring],
      },
    };
  }

  // Auto-deprecate gap-flagged candidates: they can't enter the
  // tie-break pool (their confidence_score is NULL by design of
  // Mode 2's short-circuit path). Recorded separately in the result
  // so the audit trail shows why they didn't participate.
  const incompleteIds = candidates
    .filter((c) => c.incompleteComposition === true)
    .map((c) => c.id);
  const eligibleCandidates = candidates.filter((c) => c.incompleteComposition !== true);

  // Load per-candidate composition + underlying market/audience/
  // business_model rows + evidence timestamps in one batch so the
  // pure function's tie-break dimensions can be derived. This is
  // one round-trip per unique node id — cheap for MVP-scale
  // candidate counts.
  const forCompression: CandidateForCompression[] = [];
  const config = options.minFounderFitThreshold !== undefined
    ? undefined
    : await scoringConfigRepository.latestForVertical(run.vertical);
  // If the caller didn't override weights, use scoring_config's
  // qualityWeight/founderFitWeight so Compression's venture_score
  // formula stays in lockstep with what Scoring's config says —
  // otherwise venture_score gets computed with a different weight
  // pair than Scoring assumed, which would silently drift.
  const compConfig: VentureScoreConfig = {
    minFounderFitThreshold: options.minFounderFitThreshold ?? DEFAULT_MIN_FOUNDER_FIT_THRESHOLD,
    qualityWeight: options.qualityWeight ?? config?.qualityWeight ?? DEFAULT_QUALITY_WEIGHT,
    founderFitWeight: options.founderFitWeight ?? config?.founderFitWeight ?? DEFAULT_FOUNDER_FIT_WEIGHT,
  };

  const recencyProvenanceByCandidateId: NonNullable<CompressionRunResult["recencyProvenanceByCandidateId"]> = [];
  const tiebreakInputProvenanceByCandidateId: NonNullable<CompressionRunResult["tiebreakInputProvenanceByCandidateId"]> = [];
  for (const c of eligibleCandidates) {
    const derived = await deriveTiebreakDimensions(c.id, run.vertical);
    forCompression.push({
      id: c.id,
      opportunityQuality: c.opportunityQuality!,
      founderFitScore: c.founderFitScore!,
      confidenceScore: c.confidenceScore!,
      distributionSubScore: derived.distributionSubScore,
      lastEvidenceSeenAt: derived.lastEvidenceSeenAt,
      operationalComplexityEstimate: derived.operationalComplexityEstimate,
    });
    recencyProvenanceByCandidateId.push({
      id: c.id,
      maxUsedTimestamp: derived.recencyProvenance.maxUsedTimestamp,
      sourcePublishedCount: derived.recencyProvenance.sourcePublishedCount,
      fetchedAtFallbackCount: derived.recencyProvenance.fetchedAtFallbackCount,
    });
    tiebreakInputProvenanceByCandidateId.push({
      id: c.id,
      provenance: derived.tiebreakInputProvenance,
    });
  }

  return agentExecutionLogService.run(
    { runId, agentName: "Compression", candidateId: null, modelUsed: null },
    async () => {
      const result = runCompression(forCompression, compConfig);

      // Precompute venture_score per candidate for the audit trail.
      const ventureScoresById = forCompression.map((c) => {
        // Recreate the same computeVentureScore call the pure
        // function used internally, purely for reporting — one line
        // duplicated is cheaper than exporting an internal helper.
        if (c.founderFitScore < compConfig.minFounderFitThreshold) {
          return { id: c.id, ventureScore: null, gated: true };
        }
        return {
          id: c.id,
          ventureScore:
            compConfig.qualityWeight * c.opportunityQuality +
            compConfig.founderFitWeight * (c.founderFitScore / 100),
          gated: false,
        };
      });

      // The full promotion transaction lives in doPromotionTransaction:
      // one $transaction with the winner update, loser deprecations,
      // gap-flagged deprecations, Opportunity insert, promotes-edge
      // insert, and pipeline_run advance — all committed atomically
      // per §8. See the header comment for the step-by-step.
      const winnerId = result.winnerId;
      let createdOpportunityId: string | null = null;

      await prisma.$transaction(async (tx) => {
        if (winnerId && result.outcome === "promoted") {
          const winner = forCompression.find((c) => c.id === winnerId)!;
          const winnerVenture = ventureScoresById.find((v) => v.id === winnerId)!.ventureScore!;

          const winnerUpdate = await tx.opportunityCandidate.updateMany({
            where: { id: winnerId, status: "candidate" },
            data: { status: "promoted" },
          });
          if (winnerUpdate.count === 0) {
            throw new Error(
              `promotion optimistic-concurrency failure: candidate ${winnerId} no longer status='candidate' at write time (another process promoted or deprecated it)`
            );
          }

          const loserIds = result.deprecated.map((d) => d.id);
          if (loserIds.length > 0) {
            // Different reasons possible — pure function's `deprecated`
            // list carries the specific reason per row.
            for (const d of result.deprecated) {
              await tx.opportunityCandidate.updateMany({
                where: { id: d.id, status: "candidate" },
                data: { status: "deprecated", deprecationReason: d.reason },
              });
            }
          }

          if (incompleteIds.length > 0) {
            await tx.opportunityCandidate.updateMany({
              where: { id: { in: incompleteIds }, status: "candidate" },
              data: { status: "deprecated", deprecationReason: "incomplete_composition" },
            });
          }

          // Read the winner's persisted fields fresh (in case
          // FounderFit's rationale was updated between our earlier
          // read and now — cheap belt-and-braces, same transaction).
          const winnerRow = await tx.opportunityCandidate.findUnique({ where: { id: winnerId } });
          if (!winnerRow) {
            throw new Error(`winner candidate ${winnerId} disappeared mid-transaction`);
          }

          const createdOpp = await tx.opportunity.create({
            data: {
              promotedFromCandidateId: winnerId,
              ventureScore: winnerVenture,
              confidenceScore: winnerRow.confidenceScore!,
              founderFitScore: winnerRow.founderFitScore!,
              founderFitRationale: winnerRow.founderFitRationale,
              // DAG §3 sub-step: LLM phrasing lands in a SECOND,
              // smaller transaction later; we insert empty arrays
              // here so the promotion tx stays short and lock-holds
              // never wait on any LLM call.
              rationaleBullets: [],
              riskSummary: [],
            },
          });
          createdOpportunityId = createdOpp.id;

          // Also cache the winner-quality reference so the outer
          // caller can log without re-reading, and to satisfy TS.
          void winner;

          await tx.edge.create({
            data: {
              edgeType: "promotes",
              fromId: winnerId,
              fromType: "opportunity_candidate",
              toId: createdOpp.id,
              toType: "opportunity",
            },
          });

          await tx.pipelineRun.update({
            where: { runId },
            data: {
              currentStage: "completed",
              status: "completed",
              completedAt: new Date(),
            },
          });
        } else {
          // insufficient_evidence branch: still deprecate everything
          // and terminate the run cleanly. This matches DAG §4's
          // "no partial output" invariant — no half-promoted state.
          for (const d of result.deprecated) {
            await tx.opportunityCandidate.updateMany({
              where: { id: d.id, status: "candidate" },
              data: { status: "deprecated", deprecationReason: d.reason },
            });
          }
          if (incompleteIds.length > 0) {
            await tx.opportunityCandidate.updateMany({
              where: { id: { in: incompleteIds }, status: "candidate" },
              data: { status: "deprecated", deprecationReason: "incomplete_composition" },
            });
          }
          await tx.pipelineRun.update({
            where: { runId },
            data: {
              currentStage: "completed",
              status: "insufficient_evidence",
              completedAt: new Date(),
            },
          });
        }
      });

      return {
        notReady: false,
        outcome: result.outcome,
        winnerId: result.winnerId,
        createdOpportunityId,
        deprecated: result.deprecated,
        incompleteCompositionDeprecated: incompleteIds,
        trace: result.trace,
        ventureScoresById,
        recencyProvenanceByCandidateId,
        tiebreakInputProvenanceByCandidateId,
      };
    },
    // graph_mutation_count semantics: candidate UPDATEs + 1 opportunity insert
    // + 1 promotes edge + 1 pipeline_run update. Approximated as
    // "committed rows touched" so the number is a real gauge of write
    // volume rather than a fixed constant per run.
    (result) => {
      if (result.notReady) return { graphMutationCount: 0 };
      const deprecatedCount = (result.deprecated?.length ?? 0) + (result.incompleteCompositionDeprecated?.length ?? 0);
      const promotedRows = result.outcome === "promoted" ? 1 : 0;
      const oppRow = result.createdOpportunityId ? 1 : 0;
      const edgeRow = result.createdOpportunityId ? 1 : 0;
      const runRow = 1;
      return { graphMutationCount: deprecatedCount + promotedRows + oppRow + edgeRow + runRow };
    }
  );
}

// Not-run terminal commit used when there's nothing for Compression
// to pick between (zero candidates). Runs OUTSIDE
// agentExecutionLogService.run because there's no pure-function call
// happening — just the terminal pipeline_run advance.
async function terminalCommit(
  runId: string,
  fields: {
    outcome: "insufficient_evidence";
    trace: string[];
    winnerId: null;
    deprecated: { id: string; reason: string }[];
    incompleteCompositionDeprecated: string[];
  }
): Promise<CompressionRunResult> {
  await prisma.pipelineRun.update({
    where: { runId },
    data: {
      currentStage: "completed",
      status: "insufficient_evidence",
      completedAt: new Date(),
    },
  });
  return {
    notReady: false,
    ...fields,
    createdOpportunityId: null,
    ventureScoresById: [],
  };
}

// Re-derives the three tie-break dimensions the pure function needs
// but that aren't persisted on opportunity_candidate directly.
// - distributionSubScore: from Scoring's pure function against the
//   composed graph (audience.acquisitionChannelsKnown drives it).
// - operationalComplexityEstimate: on business_model, straight read.
// - lastEvidenceSeenAt: max fetched_at across evidence cited by any
//   node in this candidate's composition.
async function deriveTiebreakDimensions(candidateId: string, vertical: string) {
  const compRows = await prisma.opportunityCandidateComposition.findMany({
    where: { candidateId },
  });
  const byRole = new Map(compRows.map((r) => [r.role, { nodeId: r.nodeId, nodeType: r.nodeType }]));

  const [market, audience, problem, hypothesis, businessModel, config] = await Promise.all([
    byRole.get("market") ? prisma.market.findUnique({ where: { id: byRole.get("market")!.nodeId } }) : null,
    byRole.get("audience") ? prisma.audience.findUnique({ where: { id: byRole.get("audience")!.nodeId } }) : null,
    byRole.get("problem") ? prisma.problem.findUnique({ where: { id: byRole.get("problem")!.nodeId } }) : null,
    byRole.get("hypothesis") ? prisma.hypothesis.findUnique({ where: { id: byRole.get("hypothesis")!.nodeId } }) : null,
    byRole.get("business_model")
      ? prisma.businessModel.findUnique({ where: { id: byRole.get("business_model")!.nodeId } })
      : null,
    scoringConfigRepository.latestForVertical(vertical),
  ]);

  // Distribution sub-score: re-derive via the deterministic Scoring
  // pure function. If we can't re-derive (missing composed rows or
  // config), fall back to 0.5 — a neutral value that won't tilt the
  // tie-break either way. This is a graceful-degradation fallback,
  // not a design decision to hide missing data; the audit log's
  // ventureScoresById still reflects the underlying candidate's
  // score, and the tie-break can't advance past this dimension
  // meaningfully with a wrong distribution number anyway.
  let distributionSubScore = 0.5;
  if (market && audience && problem && hypothesis && businessModel && config) {
    const maturityStage = market.maturityStage as ScoringInputs["market"]["maturityStage"];
    const scoringOut = computeOpportunityQuality(
      {
        market: { growthRateEstimate: market.growthRateEstimate, maturityStage },
        audience: {
          willingnessToPaySignal: audience.willingnessToPaySignal,
          acquisitionChannelsKnown: audience.acquisitionChannelsKnown,
        },
        problem: { severitySignal: problem.severitySignal, frequencySignal: problem.frequencySignal },
        hypothesis: {
          validationScore: hypothesis.validationScore,
          supportingEvidenceStrength: hypothesis.supportingEvidenceStrength,
        },
        businessModel: {
          marginProfile: businessModel.marginProfile,
          operationalComplexityEstimate: businessModel.operationalComplexityEstimate,
          capitalIntensityEstimate: businessModel.capitalIntensityEstimate,
        },
      },
      {
        w1Demand: config.w1Demand,
        w2Hypothesis: config.w2Hypothesis,
        w3Margin: config.w3Margin,
        w4Feasibility: config.w4Feasibility,
        w5Distribution: config.w5Distribution,
        w6Timing: config.w6Timing,
      }
    );
    distributionSubScore = scoringOut.subScores.distribution;
  }

  // P1.3 (category 1 treatment, matching scoring.ts):
  // operationalComplexityEstimate is chronic-null on nearly all current
  // business_model rows (same finding as P1.1/P2.1's scoring-side fix
  // for this exact field). Keep the neutral 0.5 default — the tiebreak
  // decision must be byte-identical to before this fix — but record
  // per-candidate whether the value driving the tiebreak was real or
  // defaulted, using the same ScoringInputProvenance shape scoring.ts
  // emits so the two observability streams are directly comparable.
  const opComplexityReal = businessModel?.operationalComplexityEstimate ?? null;
  const operationalComplexityEstimate = opComplexityReal ?? 0.5;
  const tiebreakInputProvenance: ScoringInputProvenance[] = [
    {
      field: "operationalComplexityEstimate",
      source: opComplexityReal === null ? "default" : "real",
      value: operationalComplexityEstimate,
    },
  ];

  // lastEvidenceSeenAt: max recency across evidence cited on any node
  // of this candidate. Recency prefers source-side publish date
  // (sourcePublishedAt, migration 007) — falling back to ingest
  // wall-clock (fetchedAt) only when sourcePublishedAt is null. The
  // per-row / aggregate provenance is surfaced back to the caller so
  // the tiebreak decision is auditable ("used the real source date"
  // vs "used the fetch fallback"). Empty-evidence fallback =
  // candidate's own createdAt, which at least gives a stable
  // per-candidate ordering when everything else is tied.
  const presentNodeIds = [...byRole.values()].map((v) => v.nodeId);
  let recencySource: "source_published_at" | "fetched_at_fallback" | "candidate_created_at_fallback" | "empty" =
    "empty";
  let sourcePublishedCount = 0;
  let fetchedAtFallbackCount = 0;
  let lastEvidenceSeenAt: Date | null = null;
  if (presentNodeIds.length > 0) {
    const refs = await prisma.nodeSourceRef.findMany({
      where: { nodeId: { in: presentNodeIds } },
      select: { evidenceId: true },
    });
    const evidenceIds = [...new Set(refs.map((r) => r.evidenceId))];
    if (evidenceIds.length > 0) {
      const evRows = await prisma.evidence.findMany({
        where: { id: { in: evidenceIds } },
        select: { id: true, fetchedAt: true, sourcePublishedAt: true },
      });
      const maxRes = computeMaxEvidenceRecency(evRows);
      lastEvidenceSeenAt = maxRes.lastEvidenceSeenAt;
      sourcePublishedCount = maxRes.sourcePublishedCount;
      fetchedAtFallbackCount = maxRes.fetchedAtFallbackCount;
      recencySource = maxRes.maxUsedTimestamp;
    }
  }
  if (lastEvidenceSeenAt === null) {
    const cand = await prisma.opportunityCandidate.findUnique({ where: { id: candidateId } });
    lastEvidenceSeenAt = cand?.createdAt ?? new Date();
    recencySource = "candidate_created_at_fallback";
  }

  return {
    distributionSubScore,
    operationalComplexityEstimate,
    lastEvidenceSeenAt,
    recencyProvenance: {
      maxUsedTimestamp: recencySource,
      sourcePublishedCount,
      fetchedAtFallbackCount,
    },
    tiebreakInputProvenance,
  };
}
