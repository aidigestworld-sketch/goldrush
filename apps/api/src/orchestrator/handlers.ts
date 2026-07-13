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
import { searchForHypothesisEvidence } from "../pipeline/searchForHypothesisEvidence";
import { prisma } from "../db/client";
import { makeNimLlmForAgent } from "./llmFactory";
import * as checkpoint from "./checkpoint.repository";
import { loadRunContext } from "./runContext";
import type { DagStep } from "./steps";

export interface JobData {
  runId: string;
  hypothesisId: string;
  // Optional overrides; defaults are derived from runContext + DB state.
  marketId?: string;
  problemId?: string;
  candidateId?: string;
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
  if (existing?.status === "succeeded") {
    return { skipped: true, skipReason: `step ${step} already succeeded on run ${data.runId}` };
  }
  await checkpoint.markRunning(data.runId, step);
  const result = await run();
  await checkpoint.markSucceeded(data.runId, step, result.candidateId ?? null);
  return result;
}

export const handlers: Record<DagStep, (data: JobData) => Promise<HandlerResult>> = {
  discovery: (data) =>
    withIdempotency("discovery", data, async () => {
      const llm = await makeNimLlmForAgent("Discovery");
      const result = await runDiscoveryAgent(data.runId, llm);
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
      // through to resolveProblemIdForRun — ?? stops on empty string.
      const problemId = data.problemId || ctx.problemId || (await resolveProblemIdForRun(data.runId));
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
      return { extra: { ...result } };
    }),

  hypothesis: (data) =>
    withIdempotency("hypothesis", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      const problemId = data.problemId || ctx.problemId || (await resolveProblemIdForRun(data.runId));
      if (!problemId) return { skipped: true, skipReason: "no problemId available" };
      const llm = await makeNimLlmForAgent("Hypothesis");
      const result = await runHypothesisAgent(data.runId, problemId, llm);
      return { extra: { ...result } };
    }),

  validation: (data) =>
    withIdempotency("validation", data, async () => {
      const llm = await makeNimLlmForAgent("Validation");
      const hypothesisId = await resolveHypothesisIdForRun(data.runId, data.hypothesisId);
      // Wire a live searchProvider (Tavily) so Validation exercises its
      // full evidence-fetch path. If TAVILY_API_KEY is missing, run
      // without it — Validation degrades to corpus-only classification.
      const hasTavily = !!process.env.TAVILY_API_KEY;
      const result = await runValidationAgent(data.runId, hypothesisId, llm, {
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
      const hypothesisId = await resolveHypothesisIdForRun(data.runId, data.hypothesisId);
      const result = await runConfidenceAgent(data.runId, hypothesisId, llm);
      return { extra: { ...result } };
    }),

  composition: (data) =>
    withIdempotency("composition", data, async () => {
      const hypothesisId = await resolveHypothesisIdForRun(data.runId, data.hypothesisId);
      const result = await runCompositionAgent(data.runId, hypothesisId);
      // Composition may have produced a new candidate; propagate its id
      // to the checkpoint row so downstream handlers can pick it up.
      return { candidateId: result.candidateId ?? undefined, extra: { ...result } };
    }),

  scoring: (data) =>
    withIdempotency("scoring", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      const candidateId = data.candidateId ?? (await resolveCandidateIdForRun(data.runId));
      if (!candidateId) return { skipped: true, skipReason: "no candidate found for run" };
      const result = await runScoringAgent(data.runId, candidateId, ctx.vertical);
      return { candidateId, extra: { ...result } };
    }),

  confidence_mode2: (data) =>
    withIdempotency("confidence_mode2", data, async () => {
      const candidateId = data.candidateId ?? (await resolveCandidateIdForRun(data.runId));
      if (!candidateId) return { skipped: true, skipReason: "no candidate found for run" };
      const result = await runConfidenceMode2Agent(data.runId, candidateId);
      return { candidateId, extra: { ...result } };
    }),

  founder_fit: (data) =>
    withIdempotency("founder_fit", data, async () => {
      const ctx = await loadRunContext(data.runId, data.hypothesisId);
      const candidateId = data.candidateId ?? (await resolveCandidateIdForRun(data.runId));
      if (!candidateId) return { skipped: true, skipReason: "no candidate found for run" };
      const llm = await makeNimLlmForAgent("FounderFit");
      const result = await runFounderFitAgent(data.runId, candidateId, ctx.founderId, llm);
      return { candidateId, extra: { ...result } };
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
};

// Helpers ---------------------------------------------------------------

async function resolveCandidateIdForRun(runId: string): Promise<string | null> {
  // Composition writes exactly one candidate per run (single-hypothesis
  // MVP). Pick the most recent 'candidate' row for this run.
  const row = await prisma.opportunityCandidate.findFirst({
    where: { runId, status: "candidate" },
    orderBy: { createdAt: "desc" },
  });
  return row?.id ?? null;
}

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

// For fresh runs: hypothesis agent creates a DB row with a new auto-UUID that
// differs from the orchestrator's tracking key (data.hypothesisId). This
// helper tries the tracking key first (works on re-runs) and falls back to
// the most recent active hypothesis written by this run.
async function resolveHypothesisIdForRun(runId: string, trackingKey: string): Promise<string> {
  const direct = await prisma.hypothesis.findUnique({ where: { id: trackingKey } });
  if (direct) return direct.id;
  const fallback = await prisma.hypothesis.findFirst({
    where: { status: "active", pipelineRunId: runId },
    orderBy: { createdAt: "desc" },
  });
  return fallback?.id ?? trackingKey;
}

// For fresh runs: problem agent creates a DB row before hypothesis_sources
// exists. This helper returns the preferred problemId if non-empty, otherwise
// falls back to the earliest active problem written for this run.
async function resolveProblemIdForRun(runId: string): Promise<string | undefined> {
  const fallback = await prisma.problem.findFirst({
    where: { status: "active", pipelineRunId: runId },
    orderBy: { createdAt: "asc" },
  });
  return fallback?.id;
}
