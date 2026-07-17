// Real Validation Agent (Collector) — Phase 5. AI_AGENTS.md §6.
//
// SCOPE, updated once Tavily wire-in landed:
//
// This agent's classification step (LLM call over candidate evidence)
// has always been real. What was originally stubbed is the
// active-search half of §6's contract — "MUST actively query Data
// Pipeline for disconfirming evidence." That half is now wired via
// an optional `searchProvider` — a Data Pipeline capability injected
// from the caller (see pipeline/searchForHypothesisEvidence.ts).
// When supplied, the agent runs the search BEFORE classification and
// merges retrieved evidence into the same candidate pool the
// classifier already consumes. Search and classification remain two
// distinct steps per §20.2 — the search side does not classify, the
// LLM does not fetch. When no searchProvider is supplied, the agent
// behaves exactly as before (corpus-only classification) — that's
// what preserves runValidationLive.ts's existing shape.
//
// Dry-run mode (options.dryRun=true) short-circuits BEFORE
// persistence: no Evidence row inserts, no node_source_refs writes,
// no missing_data append, no classifier LLM call. It exists so a
// caller can inspect what the search step would contribute to the
// candidate pool before committing anything to the graph. The
// classifier is skipped in dry-run because running the LLM to
// produce classifications we'd then throw away is wasteful and
// noisy — a separate script can exercise the classifier over the
// same preview pool if that's specifically what you want to see.
//
// Writes ONLY: evidence (only for search-provider-retrieved items,
// via evidenceRepository.createMany — this is the ONE case where an
// agent adds Evidence rows, per §20.2 the ingestion is happening in
// Data Pipeline and Validation is just committing them), node_source_refs
// (evidence_for/evidence_against citations), and hypothesis.missing_data
// (append-only, co-writable with Hypothesis Agent per §18.2). NEVER
// status or validation_score — that boundary is the entire reason
// Validation was split from Confidence in the first place.
//
// KNOWN MINOR LOGGING GAP (documented so it isn't mistaken for a
// regression later): graph_mutation_count on this agent's execution
// log is derived from newSupportingCitations + newContradictingCitations,
// which are counted from the classifier's output BEFORE the
// nodeSourceRefRepository.createMany call. That call uses
// skipDuplicates: true, so if the classifier ever picks an
// evidence_id that's already cited on this hypothesis (in practice
// this can happen when a Tavily result URL matches an already-
// ingested Evidence row that got surfaced again on a later run —
// the URL-dedup inside searchForHypothesisEvidence catches
// within-run dupes but not cross-run ones against the current
// DB state), the createMany silently drops those rows and the
// actual node_source_refs delta is smaller than the logged count.
// First observed as a 13-vs-15 gap on the doubled-query run
// against hypothesis 01c1110d. Not fixing the counter itself
// right now — the writes ARE correct, only the count on the
// audit log overstates by the dedup count. A future fix would be
// to count AFTER the writes (or subtract the createMany result's
// count from the pre-write intent) rather than trust the
// classifier picks as the mutation count.
import { runValidationSandboxBatched, type ValidationCandidateEvidence } from "../../sandbox/validationSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { hypothesisRepository } from "../../repositories/hypothesis.repository";
import { nodeSourceRefRepository } from "../../repositories/nodeSourceRef.repository";
import { evidenceRepository } from "../../repositories/evidence.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import type { NormalizedEvidence } from "../../pipeline/types";
import type { HypothesisSearchLogPayload } from "../../pipeline/searchForHypothesisEvidence";
import { prisma } from "../../db/client";
import { pairInsertedEvidenceByUrl } from "./validationEvidencePairing";
import { tryResolveHypothesisIdForRun } from "../../orchestrator/idResolvers";
import { selectWithinTokenBudget, getInputTokenBudgetForAgent } from "../../sandbox/tokenBudget";

export interface ValidationRunResult {
  newSupportingCitations: number;
  newContradictingCitations: number;
  newUnresolvedQuestions: number;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
  // Populated only when a searchProvider is supplied. In dry-run
  // mode these are the ONLY meaningful fields on the result — the
  // counts above are all zero because no writes happened.
  searchLogPayloads?: HypothesisSearchLogPayload[];
  searchRetrievedCount?: number;
  dryRunPreview?: {
    retrievedNormalizedEvidence: NormalizedEvidence[];
    combinedCandidatePoolSize: number;
    corpusCandidatePoolSize: number;
  };
}

// SearchProvider: caller-injected Data Pipeline capability. Kept as a
// narrow function type rather than an interface so the pipeline
// module's return shape stays authoritative — nothing on the agent
// side dictates the internal structure of Data Pipeline.
export type ValidationSearchProvider = (context: {
  runId: string;
  hypothesisId: string;
  hypothesisStatement: string;
}) => Promise<{
  normalized: NormalizedEvidence[];
  // Array because searchForHypothesisEvidence now issues one Tavily
  // call per query and up to two per hypothesis (raw + reformulated).
  // Each call's audit row is preserved separately, per §6's
  // "log the query text" requirement — a merged/opaque composite
  // would defeat the audit purpose.
  searchLogPayloads: HypothesisSearchLogPayload[];
}>;

export interface RunValidationAgentOptions {
  searchProvider?: ValidationSearchProvider;
  dryRun?: boolean;
}

// hypothesisId is `string | undefined` (not required). If no hypothesis
// exists for the run (upstream Hypothesis legitimately skipped because
// Discovery wrote zero markets, etc.) the agent skips cleanly — matches
// the tryResolve* pattern used by problem/candidate-based agents so a
// legitimate partial-completion doesn't flip pipeline_run.status to
// 'failed' with a confusing "no active hypothesis" error.
export async function runValidationAgent(
  runId: string,
  hypothesisId: string | undefined,
  llm: LLMClient,
  options: RunValidationAgentOptions = {}
): Promise<ValidationRunResult> {
  const resolvedHypothesisId = await tryResolveHypothesisIdForRun(runId, hypothesisId);
  if (!resolvedHypothesisId) {
    return {
      newSupportingCitations: 0,
      newContradictingCitations: 0,
      newUnresolvedQuestions: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: "no active hypothesis for run — upstream Hypothesis step produced no row",
    };
  }
  const hypothesis = await hypothesisRepository.findById(resolvedHypothesisId);
  if (!hypothesis || hypothesis.status !== "active") {
    return {
      newSupportingCitations: 0,
      newContradictingCitations: 0,
      newUnresolvedQuestions: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `hypothesis ${resolvedHypothesisId} not found or not active`,
    };
  }

  const alreadyCitedRefs = await prisma.nodeSourceRef.findMany({
    where: { nodeId: hypothesis.id, nodeType: "hypothesis" },
  });
  const alreadyCitedEvidenceIds = new Set(alreadyCitedRefs.map((r) => r.evidenceId));

  // Scope the uncited-evidence read to the run's vertical — same rule
  // as Discovery. Cross-vertical evidence must never appear in the
  // Validation classifier's candidate pool.
  const runForVertical = await prisma.pipelineRun.findUnique({ where: { runId } });
  if (!runForVertical) throw new Error(`pipeline_run ${runId} not found`);
  const uncitedEvidence = await prisma.evidence.findMany({
    where: {
      status: "active",
      vertical: runForVertical.vertical,
      id: { notIn: [...alreadyCitedEvidenceIds] },
    },
  });

  // Preserve sourceType + recency alongside each candidate so
  // selectWithinTokenBudget can rank the combined corpus (see below)
  // by source authority + recency. The sandbox itself only needs
  // {id, sourceUrlOrIdentifier, text} — we strip the extra fields
  // after budget selection.
  type CandidateWithMeta = ValidationCandidateEvidence & {
    sourceType: string;
    recencyAt: Date | null;
  };
  const corpusCandidates: CandidateWithMeta[] = uncitedEvidence.map((e) => ({
    id: e.id,
    sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
    text: e.extractedFact,
    sourceType: e.sourceType,
    recencyAt: e.sourcePublishedAt ?? e.fetchedAt ?? null,
  }));

  // Active-search step (§6 invariant). Runs BEFORE classification when
  // a searchProvider is supplied. In dry-run mode this is the only
  // step that produces observable output — the classifier is skipped.
  let searchLogPayloads: HypothesisSearchLogPayload[] | undefined;
  let retrievedNormalizedEvidence: NormalizedEvidence[] = [];
  if (options.searchProvider) {
    const searchResult = await options.searchProvider({
      runId,
      hypothesisId: hypothesis.id,
      hypothesisStatement: hypothesis.statement,
    });
    retrievedNormalizedEvidence = searchResult.normalized;
    searchLogPayloads = searchResult.searchLogPayloads;
  }

  if (options.dryRun) {
    return {
      newSupportingCitations: 0,
      newContradictingCitations: 0,
      newUnresolvedQuestions: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason:
        "dry-run mode — search-and-normalize step completed; classification and persistence deliberately skipped",
      searchLogPayloads,
      searchRetrievedCount: retrievedNormalizedEvidence.length,
      dryRunPreview: {
        retrievedNormalizedEvidence,
        combinedCandidatePoolSize: corpusCandidates.length + retrievedNormalizedEvidence.length,
        corpusCandidatePoolSize: corpusCandidates.length,
      },
    };
  }

  // Non-dry-run past this point.
  // Retrieved-via-search evidence has to land in the evidence table
  // FIRST so its DB-assigned id can then be cited by node_source_refs.
  // This is the only agent write path that inserts Evidence rows —
  // permitted per §20.2 because the actual retrieval + normalization
  // happened in Data Pipeline (searchProvider); this agent is just
  // committing the pipeline's output.
  const searchCandidates: CandidateWithMeta[] = [];
  if (retrievedNormalizedEvidence.length > 0) {
    // Tag the newly-fetched evidence with this run's vertical — search
    // is initiated per-run, so its results are per-vertical by
    // construction. Same rule as the ingest pipeline: no orphan rows.
    await evidenceRepository.createMany(retrievedNormalizedEvidence, runForVertical.vertical);
    // Recover the just-inserted rows' real DB ids and pair them with
    // their source NormalizedEvidence by sourceUrlOrIdentifier, NOT by
    // findMany return order. Evidence.sourceUrlOrIdentifier has no
    // unique constraint (schema.prisma), and search_signal rows for
    // the same URL can accumulate across runs — a plain index-based
    // pairing (retrievedNormalizedEvidence[i] ↔ inserted[i]) is
    // therefore unsafe: findMany makes no ordering guarantee, and
    // without vertical/URL keying it can even surface a row from an
    // unrelated run. Misaligned pairing propagates a wrong evidence_id
    // into node_source_refs, so Confidence Mode 1 later reads the
    // classifier's supports/contradicts verdict against the wrong row.
    const uniqueUrls = Array.from(new Set(retrievedNormalizedEvidence.map((e) => e.sourceUrlOrIdentifier)));
    const inserted = await prisma.evidence.findMany({
      where: {
        sourceUrlOrIdentifier: { in: uniqueUrls },
        sourceType: "search_signal",
        vertical: runForVertical.vertical,
      },
      orderBy: { fetchedAt: "desc" },
    });
    // Newest-fetchedAt-first + first-write-wins isolates the row we
    // just inserted for each URL (this call's fetchedAt is by
    // construction later than any earlier run's for the same URL).
    // Prior-run rows for the same URL/vertical are ignored rather
    // than being cited against text they weren't actually extracted
    // from. A genuine lookup miss is skipped with a warning — never
    // papered over with a placeholder id, which used to forward a
    // non-existent evidence_id into node_source_refs and trip the FK.
    const paired = pairInsertedEvidenceByUrl(retrievedNormalizedEvidence, inserted);
    // Tag every search-retrieved candidate as search_signal + fetched-now
    // for the token-budget ranker below. Both are true by construction:
    // the evidenceRepository.createMany call above always writes
    // sourceType='search_signal', and the just-inserted row's fetchedAt
    // is this instant. Also cross-reference the inserted rows to grab
    // the actual DB fetchedAt (accurate to the millisecond) rather than
    // recomputing new Date() here — same principle as pairInsertedEvidenceByUrl
    // (don't fabricate what the DB already knows).
    const insertedById = new Map(inserted.map((r) => [r.id, r]));
    for (const c of paired.candidates) {
      searchCandidates.push({
        ...c,
        sourceType: "search_signal",
        recencyAt: insertedById.get(c.id)?.fetchedAt ?? new Date(),
      });
    }
    for (const url of paired.droppedUrls) {
      console.warn(
        `[validationAgent] dropping search-retrieved evidence — no DB row found for ${url} in vertical ${runForVertical.vertical}`
      );
    }
  }
  const combinedCandidates: CandidateWithMeta[] = [...corpusCandidates, ...searchCandidates];

  if (combinedCandidates.length === 0) {
    return {
      newSupportingCitations: 0,
      newContradictingCitations: 0,
      newUnresolvedQuestions: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason:
        "no candidate evidence: neither the existing corpus nor the search step returned anything new to classify",
      searchLogPayloads,
      searchRetrievedCount: retrievedNormalizedEvidence.length,
    };
  }

  // Token-budget selection over corpus + search-retrieved candidates,
  // same pattern as Discovery / Expansion / CompetitiveAnalysis.
  // Prevents the input-token-overflow class that hit this agent on
  // 2026-07-16 (114689 input tokens against nvidia/llama-3.3-nemotron-
  // super-49b-v1's 131072 ceiling, model context reserved 16384 for
  // output → over the limit). Validation reads *all* uncited active
  // evidence in the vertical, so its corpus scales the same way
  // Discovery's does — the same fix pattern applies.
  //
  // Budget is per-AGENT+model, not just per-model: Validation on the
  // super-49b model gets a tighter 75K budget (vs the model-wide 105K)
  // to reduce NIM gateway pressure — the shared upstream started
  // returning 504 gateway timeouts consistently at ~105K input on
  // 2026-07-16. Trades ~25% fewer classified candidates (the
  // lowest-authority + oldest, already deprioritized by the ranker)
  // for a meaningful drop in prefill time. Other agents on the same
  // model keep 105K. See tokenBudget.ts for the override table.
  const modelId = (llm as { model?: string }).model;
  const budgetResult = selectWithinTokenBudget(
    combinedCandidates.map((c) => ({
      id: c.id,
      sourceType: c.sourceType,
      text: c.text,
      recencyAt: c.recencyAt,
    })),
    getInputTokenBudgetForAgent("Validation", modelId)
  );
  if (budgetResult.droppedCount > 0) {
    console.warn(
      `[Validation] token-budget: kept ${budgetResult.selected.length}/${combinedCandidates.length} evidence rows ` +
        `(~${budgetResult.totalTokensEstimated} tokens, budget=${budgetResult.budgetTokens}), ` +
        `dropped by source_type: ${JSON.stringify(budgetResult.droppedBySourceType)}`
    );
  }
  const selectedIds = new Set(budgetResult.selected.map((s) => s.id));
  const candidates: ValidationCandidateEvidence[] = combinedCandidates
    .filter((c) => selectedIds.has(c.id))
    .map((c) => ({ id: c.id, sourceUrlOrIdentifier: c.sourceUrlOrIdentifier, text: c.text }));

  return agentExecutionLogService.run(
    { runId, agentName: "Validation", candidateId: null, modelUsed: (llm as { model?: string }).model ?? null },
    async (ctx) => {
      // Batched: splits into ≤60-row chunks and runs them in parallel
      // to avoid the ~300s NIM gateway wall the single-call path hit
      // on 2026-07-17 at 131 rows / 8192 output tokens (finish=length).
      // See runValidationSandboxBatched header for the safety argument
      // (per-row classification is independent → concat is correct).
      const result = await runValidationSandboxBatched(llm, {
        hypothesis: { id: hypothesis.id, statement: hypothesis.statement },
        candidates,
      });
      ctx.setRawOutput(result.rawResponse);

      if (!result.parsed) {
        throw new Error(`Validation Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          newSupportingCitations: 0,
          newContradictingCitations: 0,
          newUnresolvedQuestions: 0,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      const supporting = result.parsed.classified_evidence.filter((c) => c.classification === "supports");
      const contradicting = result.parsed.classified_evidence.filter((c) => c.classification === "contradicts");
      // "inconclusive" items are deliberately NOT cited as either —
      // this is the mechanism-mismatch case (validationSandbox.ts's
      // whole reason for existing): don't force a weak/irrelevant
      // match into evidence_for or evidence_against.

      // evidence_polarity is set explicitly here — this is the whole
      // point of the split with Hypothesis Agent's write path (which
      // only ever produces evidence_for and takes the DB default).
      // Before migration 003, both branches wrote identically and the
      // polarity signal was silently discarded on commit; now it
      // round-trips to disk and Confidence Agent (§7) can actually
      // see it.
      await nodeSourceRefRepository.createMany(
        supporting.map((c) => ({
          nodeId: hypothesis.id,
          nodeType: "hypothesis" as const,
          evidenceId: c.evidence_id,
          evidencePolarity: "supporting" as const,
        }))
      );
      await nodeSourceRefRepository.createMany(
        contradicting.map((c) => ({
          nodeId: hypothesis.id,
          nodeType: "hypothesis" as const,
          evidenceId: c.evidence_id,
          evidencePolarity: "contradicting" as const,
        }))
      );

      if (result.parsed.unresolved_questions.length > 0) {
        await hypothesisRepository.appendMissingData(hypothesis.id, result.parsed.unresolved_questions);
      }

      return {
        newSupportingCitations: supporting.length,
        newContradictingCitations: contradicting.length,
        newUnresolvedQuestions: result.parsed.unresolved_questions.length,
        boundedRuleViolations: [],
        skipped: false,
        searchLogPayloads,
        searchRetrievedCount: retrievedNormalizedEvidence.length,
      };
    },
    (result) => ({ graphMutationCount: result.newSupportingCitations + result.newContradictingCitations })
  );
}
