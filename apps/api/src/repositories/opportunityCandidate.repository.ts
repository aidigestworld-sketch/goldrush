// OpportunityCandidate read + partial-write access.
//
// Multiple agents (FounderFit, Scoring, Confidence Mode 2, Compression)
// write different disjoint columns on the same row per §18.2's
// write-scope matrix. This repository exposes ONLY the narrow write
// paths currently needed by whichever live agent is being built —
// grows one method at a time as agents are wired.
//
// Every write method here MUST use Prisma's targeted `data: { <owned
// columns only> }` shape — never a full-row replace built from a
// stale in-memory copy. This is the AGENT_EXECUTION_DAG.md §5
// disjoint-column concurrency guarantee enforced at the query-
// construction level, not left as an assumption. Prisma's update()
// with a `data` object issues an UPDATE ... SET only on the named
// columns, which is exactly what §5 requires for FounderFit (10b)
// and Confidence Mode 2 (10a) to write the same row concurrently
// without one silently overwriting the other's columns.
import { prisma } from "../db/client";

export const opportunityCandidateRepository = {
  findById(id: string) {
    return prisma.opportunityCandidate.findUnique({ where: { id } });
  },

  // FounderFit Agent's ONLY write path against this row (§18.2 —
  // founder_fit_score and founder_fit_rationale are FounderFit-only
  // fields, no other agent may write them).
  setFounderFit(id: string, score: number, rationale: string) {
    return prisma.opportunityCandidate.update({
      where: { id },
      data: {
        founderFitScore: score,
        founderFitRationale: rationale,
      },
    });
  },

  // Confidence Mode 2's ONLY write path against this row (§18.2 —
  // confidence_score, confidence_agreement, confidence_freshness,
  // confidence_coverage_gate, incomplete_composition are Confidence-
  // Mode-2-only fields). Disjoint from FounderFit's setFounderFit
  // above by construction; either call is safe to issue against the
  // same candidate id concurrently.
  //
  // All five fields are always written together in ONE UPDATE — even
  // in the coverage-gate-failed short-circuit case (four of them
  // land as NULL, incomplete_composition lands as TRUE). Compression's
  // reader needs to distinguish "not yet scored" (all NULL) from
  // "scored, gate failed" (nulls + incomplete_composition=TRUE); the
  // all-in-one-UPDATE contract is what makes that distinction
  // reliable — no window where confidence_agreement is committed but
  // incomplete_composition is not.
  setConfidenceMode2(
    id: string,
    fields: {
      confidenceScore: number | null;
      confidenceAgreement: number | null;
      confidenceFreshness: number | null;
      confidenceCoverageGate: boolean;
      incompleteComposition: boolean;
    }
  ) {
    return prisma.opportunityCandidate.update({
      where: { id },
      data: fields,
    });
  },
};
