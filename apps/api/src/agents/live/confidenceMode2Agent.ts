// Real Confidence Mode 2 Agent — DAG stage 10a. AI_AGENTS.md §7 Mode 2.
//
// Runs off Scoring's completion, same trigger as FounderFit (10b) —
// both branches fork on the completed opportunity_candidate and write
// to disjoint column sets. See AGENT_EXECUTION_DAG.md §5's write-path
// diagram.
//
// This is a DETERMINISTIC agent (no LLM call) — the whole computation
// lives in ../confidenceMode2.ts's pure function, and this wrapper's
// only job is:
//   1. Load the candidate + its composition_rows + those rows'
//      node_source_refs (with polarity) + the cited Evidence rows'
//      fetched_at timestamps
//   2. Shape those into ConfidenceMode2Input
//   3. Call computeConfidenceMode2()
//   4. Persist the 5 owned columns via a single targeted UPDATE
//      (§5 disjoint-column concurrency requirement — enforced at the
//      query-construction level by opportunityCandidateRepository.
//      setConfidenceMode2, never a full-row replace)
//   5. Log the execution via agentExecutionLogService.run
//
// Writes ONLY: opportunity_candidate.{confidence_score,
// confidence_agreement, confidence_freshness, confidence_coverage_gate,
// incomplete_composition}. NEVER touches FounderFit's columns
// (founder_fit_score, founder_fit_rationale), Scoring's column
// (opportunity_quality), Compression's column (venture_score), status,
// or any structural graph rows.
//
// SHORT-CIRCUIT path (incomplete_composition == true): the pure
// function returns nulls for agreement/freshness/confidence_score
// and this wrapper writes those nulls verbatim, plus
// confidence_coverage_gate=FALSE and incomplete_composition=TRUE. This
// is a legitimate candidate state Compression will use to distinguish
// "not yet scored" (all five columns NULL) from "scored, gap-flagged"
// (nulls with incomplete_composition=TRUE). Per the task spec this
// is NOT a throw — the DB row is committed, Compression reads it and
// decides what to do.
import {
  computeConfidenceMode2,
  COMPOSITION_ROLES,
  type CompositionRole,
  type CompositionSlot,
  type EvidenceItem,
  type SlotEvidenceCounts,
} from "../confidenceMode2";
import { opportunityCandidateRepository } from "../../repositories/opportunityCandidate.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

export interface ConfidenceMode2RunResult {
  candidateId: string;
  confidenceScore: number | null;
  agreement: number | null;
  freshness: number | null;
  coverageGate: 0 | 1;
  incompleteComposition: boolean;
  slotEvidenceCounts: SlotEvidenceCounts[];
  skipped: boolean;
  skipReason?: string;
}

export async function runConfidenceMode2Agent(
  runId: string,
  candidateId: string
): Promise<ConfidenceMode2RunResult> {
  const candidate = await opportunityCandidateRepository.findById(candidateId);
  if (!candidate) {
    return skip(candidateId, `opportunity_candidate ${candidateId} not found`);
  }
  // §7 Mode 2 input filter: candidate.status must be 'candidate' AND
  // opportunity_quality must be set (Scoring, stage 9, must have
  // committed first — this branch is downstream of that in the DAG).
  if (candidate.status !== "candidate") {
    return skip(
      candidateId,
      `candidate ${candidateId} is status='${candidate.status}', not 'candidate'`
    );
  }
  if (candidate.opportunityQuality === null) {
    return skip(
      candidateId,
      `candidate ${candidateId} has opportunity_quality=NULL — Scoring Agent (stage 9) must run first`
    );
  }

  // Load composition rows (one per role, up to 5). Under §8's
  // invariant this returns exactly 5 for any candidate that reached
  // Mode 2 — but the pure function handles the incomplete case
  // defensively, so we pass whatever we find rather than pre-rejecting.
  const compositionRows = await prisma.opportunityCandidateComposition.findMany({
    where: { candidateId },
  });
  const byRole = new Map<CompositionRole, { nodeId: string; nodeType: string }>();
  for (const r of compositionRows) {
    if ((COMPOSITION_ROLES as readonly string[]).includes(r.role)) {
      byRole.set(r.role as CompositionRole, { nodeId: r.nodeId, nodeType: r.nodeType });
    }
  }

  // For each present composition row, load its node_source_refs
  // (polarity lives on the edge, not on the evidence — see the audit
  // finding documented in confidenceMode2.ts's header). Batch the
  // lookup by nodeId+nodeType to avoid N sequential queries.
  const presentNodeIds = [...byRole.values()].map((v) => v.nodeId);
  const allRefs =
    presentNodeIds.length === 0
      ? []
      : await prisma.nodeSourceRef.findMany({
          where: { nodeId: { in: presentNodeIds } },
        });

  const slots: CompositionSlot[] = COMPOSITION_ROLES.map<CompositionSlot>((role) => {
    const entry = byRole.get(role);
    if (!entry) {
      return { role, isNull: true, sourceRefs: [] };
    }
    const refsForNode = allRefs.filter(
      (r) => r.nodeId === entry.nodeId && r.nodeType === entry.nodeType
    );
    return {
      role,
      isNull: false,
      sourceRefs: refsForNode.map((r) => ({
        evidenceId: r.evidenceId,
        // node_source_refs.evidence_polarity is CHECK-constrained to
        // 'supporting' | 'contradicting' at the DB level (migration
        // 003), so this cast is safe. Anything else would already
        // have failed the CHECK before this read.
        evidencePolarity: r.evidencePolarity as "supporting" | "contradicting",
      })),
    };
  });

  // Build the deduped evidence list. The audit extraction dedupes by
  // evidence_id across nodes; do the same here so the pure function
  // sees one entry per distinct evidence row (its freshness formula
  // averages across distinct evidence, not weighted by citation count).
  const distinctEvidenceIds = new Set<string>();
  for (const slot of slots) {
    for (const ref of slot.sourceRefs) distinctEvidenceIds.add(ref.evidenceId);
  }
  let evidence: EvidenceItem[] = [];
  if (distinctEvidenceIds.size > 0) {
    const evidenceRows = await prisma.evidence.findMany({
      where: { id: { in: [...distinctEvidenceIds] } },
      select: { id: true, fetchedAt: true, sourcePublishedAt: true },
    });
    evidence = evidenceRows.map((e) => ({
      evidenceId: e.id,
      fetchedAt: e.fetchedAt,
      sourcePublishedAt: e.sourcePublishedAt,
    }));
  }

  return agentExecutionLogService.run(
    {
      runId,
      agentName: "ConfidenceMode2",
      candidateId,
      // Deterministic — no model to log. Matches Filtering / Composition
      // / Scoring / Compression conventions (see agent_execution_log
      // schema comment about model_used being NULL for deterministic
      // agents, DAG §1).
      modelUsed: null,
    },
    async () => {
      const result = computeConfidenceMode2({ slots, evidence });

      // Persist all 5 owned columns in ONE targeted UPDATE — the
      // repository method enforces the query shape (§5 disjoint-
      // column safety), including the short-circuit path where four
      // of them are NULL. See setConfidenceMode2's header comment.
      await opportunityCandidateRepository.setConfidenceMode2(candidate.id, {
        confidenceScore: result.confidenceScore,
        confidenceAgreement: result.agreement,
        confidenceFreshness: result.freshness,
        confidenceCoverageGate: result.coverageGate === 1,
        incompleteComposition: result.incompleteComposition,
      });

      return {
        candidateId: candidate.id,
        confidenceScore: result.confidenceScore,
        agreement: result.agreement,
        freshness: result.freshness,
        coverageGate: result.coverageGate,
        incompleteComposition: result.incompleteComposition,
        slotEvidenceCounts: result.slotEvidenceCounts,
        skipped: false,
      };
    },
    // graph_mutation_count semantics: exactly 1 column-write bundle
    // per successful run (five columns updated atomically on the
    // same row = one UPDATE statement = one mutation for audit
    // purposes). Matches how FounderFit counts its own bundled
    // update (see founderFitAgent.ts's extractMetrics).
    (result) => ({ graphMutationCount: result.skipped ? 0 : 1 })
  );
}

function skip(candidateId: string, reason: string): ConfidenceMode2RunResult {
  return {
    candidateId,
    confidenceScore: null,
    agreement: null,
    freshness: null,
    coverageGate: 0,
    incompleteComposition: false,
    slotEvidenceCounts: [],
    skipped: true,
    skipReason: reason,
  };
}
