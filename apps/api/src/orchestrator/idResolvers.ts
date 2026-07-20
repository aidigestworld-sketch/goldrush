// Shared id-resolvers for orchestrator-scheduled agents.
//
// Bug class prevented: `prisma.X.findUnique({ where: { id: undefined } })`.
// Prisma rejects an undefined id with "Invalid prisma.X.findUnique()
// invocation" — which is what surfaces when a Stripe-originated run
// (no pre-existing trackingKey in JobData) reaches an agent that
// blindly forwards the caller's id to findUnique.
//
// Every resolver here follows the same shape:
//   1. If a trackingKey (previous id) is provided AND findable, use it.
//   2. Otherwise, fall back to the newest active row for this run.
//   3. Otherwise, throw a loud, run-scoped error — never return undefined.
//
// Agents call these at their entry points so the guarantee holds even
// when callers pass `undefined` at runtime (as BullMQ payloads legally
// can, since JobData.hypothesisId / problemId / candidateId are all
// optional).

import { prisma } from "../db/client";

// For fresh runs: hypothesis agent creates a DB row with a new auto-UUID that
// differs from the orchestrator's tracking key (data.hypothesisId). This
// helper tries the tracking key first (works on re-runs) and falls back to
// the most recent active hypothesis written by this run.
//
// trackingKey is string | undefined because JobData.hypothesisId is optional:
// Stripe-originated runs never have a pre-existing hypothesisId. For those
// runs, skip findUnique entirely (Prisma throws on { where: { id: undefined } })
// and use the fallback path directly.
export async function resolveHypothesisIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string> {
  const id = await tryResolveHypothesisIdForRun(runId, trackingKey);
  if (!id) throw new Error(`resolveHypothesisIdForRun: no active hypothesis found for runId=${runId}`);
  return id;
}

// Skip-tolerant variant. Used by validation, confidence and composition
// agents so a run where an upstream step legitimately skipped (e.g.
// Discovery wrote zero markets, so Expansion, CA and Hypothesis all
// early-returned via their handler-level guards without producing a
// row) resolves to a graceful skip instead of a hard failure. The
// throw-variant remains for scripts/live-runners that ARE calling with
// a real prior id and want a loud error when it's missing.
export async function tryResolveHypothesisIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string | null> {
  if (trackingKey) {
    const direct = await prisma.hypothesis.findUnique({ where: { id: trackingKey } });
    if (direct) return direct.id;
  }
  const fallback = await prisma.hypothesis.findFirst({
    where: { status: "active", pipelineRunId: runId },
    orderBy: { createdAt: "desc" },
  });
  return fallback?.id ?? null;
}

// Same shape as resolveHypothesisIdForRun but for problems.
export async function resolveProblemIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string> {
  const id = await tryResolveProblemIdForRun(runId, trackingKey);
  if (!id) throw new Error(`resolveProblemIdForRun: no active problem found for runId=${runId}`);
  return id;
}

// Skip-tolerant variant of resolveProblemIdForRun. Returns null when
// no active problem exists for the run, so callers that legitimately
// skip (e.g., competitive_analysis on a run that had no expansion
// output) can branch on it without a try/catch.
export async function tryResolveProblemIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string | null> {
  if (trackingKey) {
    const direct = await prisma.problem.findUnique({ where: { id: trackingKey } });
    if (direct) return direct.id;
  }
  const fallback = await prisma.problem.findFirst({
    where: { status: "active", pipelineRunId: runId },
    orderBy: { createdAt: "asc" },
  });
  return fallback?.id ?? null;
}

// Same shape as the others but for the promoted Opportunity row.
// Compression creates exactly one opportunity per run when it promotes
// a winner. OpportunityRationale reads the id from the JobData if the
// handler forwards it, but falls back to "the opportunity whose
// promoted_from_candidate_id points at any candidate on this run" so a
// resume/retry after a checkpoint reset still works without the
// caller having tracked the id explicitly.
export async function resolveOpportunityIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string> {
  const id = await tryResolveOpportunityIdForRun(runId, trackingKey);
  if (!id) throw new Error(`resolveOpportunityIdForRun: no opportunity found for runId=${runId}`);
  return id;
}

// Skip-tolerant variant. Returns null when no Opportunity exists yet
// (Compression legitimately didn't promote — insufficient_evidence
// terminal), which is the case OpportunityRationale should skip on.
export async function tryResolveOpportunityIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string | null> {
  if (trackingKey) {
    const direct = await prisma.opportunity.findUnique({ where: { id: trackingKey } });
    if (direct) return direct.id;
  }
  // Find via the promoted candidate on this run. Single-hypothesis MVP
  // means at most one promoted candidate per run.
  const promoted = await prisma.opportunityCandidate.findFirst({
    where: { runId, status: "promoted" },
    orderBy: { createdAt: "desc" },
  });
  if (!promoted) return null;
  const opp = await prisma.opportunity.findFirst({
    where: { promotedFromCandidateId: promoted.id },
  });
  return opp?.id ?? null;
}

// Same shape as the others but for opportunity_candidate rows. Called by
// scoring, confidence_mode2 and founder_fit agents. Composition writes
// exactly one candidate per run (single-hypothesis MVP), so the fallback
// is "the most recent status='candidate' row for this run."
export async function resolveCandidateIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string> {
  const id = await tryResolveCandidateIdForRun(runId, trackingKey);
  if (!id) throw new Error(`resolveCandidateIdForRun: no candidate found for runId=${runId}`);
  return id;
}

// Skip-tolerant variant of resolveCandidateIdForRun. Returns null when
// no candidate exists — the expected state for runs where Composition
// skipped (e.g., below-gate hypothesis).
export async function tryResolveCandidateIdForRun(
  runId: string,
  trackingKey: string | undefined
): Promise<string | null> {
  if (trackingKey) {
    const direct = await prisma.opportunityCandidate.findUnique({ where: { id: trackingKey } });
    if (direct) return direct.id;
  }
  const fallback = await prisma.opportunityCandidate.findFirst({
    where: { runId, status: "candidate" },
    orderBy: { createdAt: "desc" },
  });
  return fallback?.id ?? null;
}
