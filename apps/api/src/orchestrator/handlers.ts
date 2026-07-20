// Job handlers — one per DAG step. Every handler follows the same shape:
//   1. Check dag_run_state for (runId, step) — if already succeeded,
//      no-op and return early (idempotency backbone).
//   2. Mark running.
//   3. Delegate to the corresponding live agent function.
//   4. On success, mark succeeded (and record candidateId if produced).
//   5. On throw, let it propagate — BullMQ retries per attempts config.
//      The queue's `failed` event listener (see worker.ts) calls
//      markFailedPermanent once retries are exhausted.
//
// The handlers deliberately do NOT reimplement any agent logic — they
// wrap live/*Agent.ts entry points 1:1. If an agent gains a new
// argument, only the corresponding handler changes here.

import { runDiscoveryAgent } from "../agents/live/discoveryAgent";
import { runExpansionAgent } from "../agents/live/expansionAgent";
import { runFilteringAgent } from "../agents/live/filteringAgent";
import { runCompetitiveAnalysisAgent } from "../agents/live/competitiveAnalysisAgent";
import { runHypothesisAgent } from "../agents/live/hypothesisAgent";
import { runValidationAgent } from "../agents/live/validationAgent";
import { runConfidenceAgent } from "../agents/live/confidenceAgent";
import { runCompositionAgent } from "../agents/live/compositionAgent";
import { runScoringAgent } from "../agents/live/scoringAgent";
import { runConfidenceMode2Agent } from "../agents/live/confidenceMode2Agent";
import { runFounderFitAgent } from "../agents/live/founderFitAgent";
import { runCompressionAgent } from "../agents/live/compressionAgent";
import { runOpportunityRationaleAgent } from "../agents/live/opportunityRationaleAgent";
import { searchForHypothesisEvidence } from "../pipeline/searchForHypothesisEvidence";
import { prisma } from "../db/client";
import { makeNimLlmForAgent } from "./llmFactory";
import * as checkpoint from "./checkpoint.repository";
import { loadRunContext } from "./runContext";
import {
  tryResolveProblemIdForRun,
  tryResolveCandidateIdForRun,
  tryResolveOpportunityIdForRun,
} from "./idResolvers";
import type { DagStep } from "./steps";

export interface JobData {
  runId: string;
  hypothesisId?: string;
  // Optional overrides; defaults are derived from runContext + DB state.
  marketId?: string;
  problemId?: string;
  candidateId?: string;
  // Populated when advance() enqueues opportunity_rationale after
  // compression — Compression returns the id of the newly-created
  // opportunity row, so the follow-on handler can go straight to it
  // without a fallback DB lookup. If missing (resume/retry from
  // checkpoint), the handler self-resolves via idResolvers.
  opportunityId?: string;
  // CompetitiveAnalysis: name-to-evidence-ids map. Serialized as a
  // plain object over the job payload; converted to Map inside the
  // handler.
  competitorNamesToEvidenceIds?: Record<string, string[]>;
}

export interface HandlerResult {
  candidateId?: string | null;
  skipped?: boolean;
  skipReason?: string;
  extra?: Record<string, unknown>;
}

async function withIdempotency(
  step: DagStep,
  data: JobData,
  run: () => Promise<HandlerResult>
): Promise<HandlerResult> {
  const existing = await checkpoint.getRow(data.runId, step);
  if (!existing) {
    // No dag_run_state row for this (runId, step). Either the row was
    // never created (phantom BullMQ job leftover in Redis from a prior
    // test/debug session whose DB rows were cleaned up), or it was
    // deleted between enqueue and worker pickup (operator/script reset).
    // Skip silently — no agent run, no NIM call, no DB writes. The job
    // ends "completed" from BullMQ's perspective, no retry storm.
    // The 2026-07-18 study surfaced this: phantom jobs burned 15 min
    // of NIM wall time each on P2025 markRunning failures × 3 retries.
    return {
      skipped: true,
      skipReason: `no dag_run_state row for run=${data.runId} step=${step} — presumed cancelled or phantom`,
    };
  }
  if (existing.status === "succeeded") {
    return { skipped: true, skipReason: `step ${step} already succeeded on run ${data.runId}` };
  }
  const running = await checkpoint.markRunning(data.runId, step);
  if (!running) {
    // Defense-in-depth: row disappeared between getRow and markRunning.
    // Same skip semantics as the null-existing branch.
    return {
      skipped: true,
      skipReason: `dag_run_state row for run=${data.runId} step=${step} deleted mid-flight — presumed cancelled`,
    };
  }
  const result = await run();
  await checkpoint.markSucceeded(data.runId, step, result.candidateId ?? null);
  return result;
}

export const handlers: Record<DagStep, (data: JobData) => Promise<HandlerResult>> = {
  discovery: (data) =>
    withIdempotency("discovery", data, async () => {
      const llm = await makeNimLlmForAgent("Discovery");
      const result = await runDiscoveryAgent(data.runId, llm);
      // Same shape as expansion below: treat "ran cleanly but produced
      // zero output" as transient and retry. The ba923046 incident on
      // 2026-07-15 hit this: Discovery's attempt 2 succeeded with
      // marketsCreated=0 despite 179 search_signal + 3 competitor_material +
      // more evidence rows in shopify_subscriptions — a transient mid-tier-
      // model output-quality miss that a fresh call typically recovers from.
      //
      // CRITICAL: only retry when the run WASN'T skipped. A skipped result
      // (result.skipped === true) means Discovery hit a genuine precondition
      // guard — evidenceRows.length === 0 for its vertical, OR bounded-rule
      // violations already logged separately. Retrying either wouldn't help
      // (evidence doesn't appear on retry; the same prompt+corpus produces
      // similar violations). The retry is scoped strictly to "no skip
      // reason, zero output" — i.e. the LLM returned an empty parsed.markets
      // despite everything being available.
      const brvCount = (result as { boundedRuleViolations?: string[] }).boundedRuleViolations?.length ?? 0;
      if (brvCount > 0 || (!result.skipped && result.marketsCreated === 0)) {
        throw new Error(
          brvCount > 0
            ? `discovery had ${brvCount} bounded-rule violation(s) — retrying`
            : "discovery ran cleanly but produced 0 markets — retrying (likely transient mid-tier-model empty-output)"
        );
      }
      return { extra: { ...result } };
    }),

  expansion: (data) =>
    withIdempotency("expansion", data, async () => {
      // Fan-out policy (single-market MVP): pick the most relevant active
      // market for this run. Multi-market fan-out is future work.
      // Selection order:
      //  1. Explicit override via data.marketId
      //  2. Market for this run tagged "customer support" (b2b vertical)
      //  3. Highest-confidence market for this run (generic fallback)
      const marketId =
        data.marketId ??
        (await prisma.market.findFirst({
          where: { status: "active", pipelineRunId: data.runId, categoryTags: { hasSome: ["customer support"] } },
          orderBy: { confidence: "desc" },
        }))?.id ??
        (await prisma.market.findFirst({
          where: { status: "active", pipelineRunId: data.runId },
          orderBy: { confidence: "desc" },
        }))?.id;
      if (!marketId) {
        return { skipped: true, skipReason: "no active market for expansion" };
      }
      const llm = await makeNimLlmForAgent("Expansion");
      const result = await runExpansionAgent(data.runId, marketId, llm);
      // Treat zero-output and bounded-rule-violation runs as transient
      // failures so BullMQ retries the remaining attempts. The LLM
      // occasionally returns empty arrays or fabricates grounding quotes
      // on the first call but produces valid problems on retry.
      const brvCount = (result as { boundedRuleViolations?: string[] }).boundedRuleViolations?.length ?? 0;
      if (brvCount > 0 || (!result.skipped && result.problemsCreated === 0 && result.audiencesCreated === 0)) {
        throw new Error(
          brvCount > 0
            ? `expansion had ${brvCount} bounded-rule violation(s) — retrying`
            : "expansion produced 0 problems and 0 audiences — retrying"
        );
      }
      return { extra: { ...result } };
    }),

  filtering: (data) =>
    withIdempotency("filtering", data, async () => {
      // DEFAULT_MIN_CONFIDENCE = 0.5 — the threshold the integration
      // test exercises on NULL-confidence rows.
      const result = await runFilteringAgent(data.runId, {});
      return { extra: { ...result } };
    }),

  competitive_analysis: (data) =>
    withIdempotency("competitive_analysis", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      // Use || not ?? so that ctx.problemId="" (no hypothesis sources yet) falls
      // through to tryResolveProblemIdForRun — ?? stops on empty string.
      const problemId =
        data.problemId || ctx.problemId || (await tryResolveProblemIdForRun(data.runId, undefined));
      if (!problemId) return { skipped: true, skipReason: "no problemId available" };

      // Same shape as the runCompetitiveAnalysisLive script: derive the
      // competitor→evidence map from active competitor_material rows,
      // scoped to this run's vertical (migration 008).
      const map = data.competitorNamesToEvidenceIds
        ? new Map(Object.entries(data.competitorNamesToEvidenceIds))
        : await deriveCompetitorMapFromEvidence(ctx.vertical);
      if (map.size === 0) {
        return { skipped: true, skipReason: "no competitor_material evidence available" };
      }
      const llm = await makeNimLlmForAgent("CompetitiveAnalysis");
      const result = await runCompetitiveAnalysisAgent(data.runId, problemId, map, llm);
      // Same pattern as discovery/expansion above: bounded-rule
      // violations from a single mid-tier LLM call are often transient
      // (evidence_ref wrapper leakage, off-by-quote grounding misses,
      // etc.) — throw so BullMQ retries with the same corpus.
      // Persistent BRVs across all 3 queue attempts still land in
      // failed_permanent via evaluateWorkerFailure, preserving the
      // same ceiling.
      const brvCount = (result as { boundedRuleViolations?: string[] }).boundedRuleViolations?.length ?? 0;
      if (brvCount > 0) {
        throw new Error(`competitive_analysis had ${brvCount} bounded-rule violation(s) — retrying`);
      }
      return { extra: { ...result } };
    }),

  hypothesis: (data) =>
    withIdempotency("hypothesis", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      const problemId =
        data.problemId || ctx.problemId || (await tryResolveProblemIdForRun(data.runId, undefined));
      if (!problemId) return { skipped: true, skipReason: "no problemId available" };
      const llm = await makeNimLlmForAgent("Hypothesis");
      const result = await runHypothesisAgent(data.runId, problemId, llm);
      return { extra: { ...result } };
    }),

  validation: (data) =>
    withIdempotency("validation", data, async () => {
      const llm = await makeNimLlmForAgent("Validation");
      // Agent self-resolves data.hypothesisId (may be undefined for
      // Stripe-originated runs). Defense-in-depth against callers
      // that forward a raw JobData.hypothesisId to findUnique.
      const hasTavily = !!process.env.TAVILY_API_KEY;
      const result = await runValidationAgent(data.runId, data.hypothesisId, llm, {
        searchProvider: hasTavily
          ? async (ctx) => {
              const out = await searchForHypothesisEvidence({
                runId: ctx.runId,
                hypothesisId: ctx.hypothesisId,
                hypothesisStatement: ctx.hypothesisStatement,
              });
              return { normalized: out.normalized, searchLogPayloads: out.searchLogPayloads };
            }
          : undefined,
      });
      return { extra: { ...result } };
    }),

  confidence_mode1: (data) =>
    withIdempotency("confidence_mode1", data, async () => {
      const llm = await makeNimLlmForAgent("Confidence");
      const result = await runConfidenceAgent(data.runId, data.hypothesisId, llm);
      return { extra: { ...result } };
    }),

  composition: (data) =>
    withIdempotency("composition", data, async () => {
      const result = await runCompositionAgent(data.runId, data.hypothesisId);
      // Composition may have produced a new candidate; propagate its id
      // to the checkpoint row so downstream handlers can pick it up.
      return { candidateId: result.candidateId ?? undefined, extra: { ...result } };
    }),

  scoring: (data) =>
    withIdempotency("scoring", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      const result = await runScoringAgent(data.runId, data.candidateId, ctx.vertical);
      return { candidateId: result.candidateId ?? undefined, extra: { ...result } };
    }),

  confidence_mode2: (data) =>
    withIdempotency("confidence_mode2", data, async () => {
      const result = await runConfidenceMode2Agent(data.runId, data.candidateId);
      return { candidateId: result.candidateId ?? undefined, extra: { ...result } };
    }),

  founder_fit: (data) =>
    withIdempotency("founder_fit", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      const llm = await makeNimLlmForAgent("FounderFit");
      const result = await runFounderFitAgent(data.runId, data.candidateId, ctx.founderId, llm);
      return { candidateId: result.candidateId ?? undefined, extra: { ...result } };
    }),

  compression: (data) =>
    withIdempotency("compression", data, async () => {
      // Defense in depth: even though the FlowProducer guarantees both
      // fork children (confidence_mode2, founder_fit) have completed
      // by the time this fires, verify their checkpoint rows are
      // succeeded before touching compressionAgent's promotion tx.
      const [cm2, ff] = await Promise.all([
        checkpoint.getRow(data.runId, "confidence_mode2"),
        checkpoint.getRow(data.runId, "founder_fit"),
      ]);
      if (cm2?.status !== "succeeded" || ff?.status !== "succeeded") {
        throw new Error(
          `compression preflight: fork branches not both succeeded (cm2=${cm2?.status}, founderFit=${ff?.status})`
        );
      }
      const result = await runCompressionAgent(data.runId);
      return { extra: { ...result } };
    }),

  opportunity_rationale: (data) =>
    withIdempotency("opportunity_rationale", data, async () => {
      // Post-terminal polish step. Compression has already committed the
      // Opportunity row with empty rationale_bullets / risk_summary
      // arrays; this step fills them in a SEPARATE transaction so
      // Compression's promotion path isn't held under LLM latency
      // (see compressionAgent.ts header). Failures here MUST NOT flip
      // the run's overall status back to in_progress — the run is
      // already user-visibly "completed" by Compression. The frontend
      // (RunResultView) already handles empty rationale/risk arrays
      // gracefully, so a permanent failure here degrades gracefully to
      // "no polish text shown," not a broken UI.
      const opportunityId =
        data.opportunityId ?? (await tryResolveOpportunityIdForRun(data.runId, undefined));
      if (!opportunityId) {
        // No promoted opportunity (Compression hit insufficient_evidence).
        // Legitimate skip — nothing to phrase.
        return { skipped: true, skipReason: "no promoted opportunity for this run" };
      }
      const llm = await makeNimLlmForAgent("OpportunityRationale");
      const result = await runOpportunityRationaleAgent(data.runId, opportunityId, llm);
      return { skipped: result.skipped, skipReason: result.skipReason, extra: { ...result } };
    }),
};

// Helpers ---------------------------------------------------------------

async function deriveCompetitorMapFromEvidence(vertical: string): Promise<Map<string, string[]>> {
  // Same convention as runCompetitiveAnalysisLive.ts's URL-pattern map.
  const rows = await prisma.evidence.findMany({
    where: { sourceType: "competitor_material", status: "active", vertical },
  });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const name = competitorNameFromUrl(r.sourceUrlOrIdentifier);
    if (!name) continue;
    const list = map.get(name) ?? [];
    list.push(r.id);
    map.set(name, list);
  }
  return map;
}

function competitorNameFromUrl(url: string): string | null {
  // Shopify subscription vertical
  if (url.includes("recharge")) return "Recharge";
  if (url.includes("loop-subscriptions")) return "Loop Subscriptions";
  if (url.includes("bold-subscriptions")) return "Bold Subscriptions";
  // B2B customer support SaaS vertical
  if (url.includes("zendesk")) return "Zendesk";
  if (url.includes("intercom")) return "Intercom";
  if (url.includes("front.com") || url.includes("frontapp")) return "Front";
  if (url.includes("freshdesk") || url.includes("freshworks")) return "Freshdesk";
  if (url.includes("helpscout") || url.includes("help-scout")) return "Help Scout";
  if (url.includes("gorgias")) return "Gorgias";
  return null;
}

// Resolvers moved to ./idResolvers.ts so agents can call them directly
// and prevent the "findUnique with id: undefined" bug class at the
// agent entry point rather than depending on the handler pre-resolving.
