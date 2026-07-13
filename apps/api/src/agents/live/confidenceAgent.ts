// Real Confidence Agent (Evaluator), Mode 1 — Phase 5. AI_AGENTS.md §7.
//
// Mode 1 only. Mode 2 (opportunity_candidate-level scoring) can't run
// until Composition has produced an OpportunityCandidate — not this
// task's scope.
//
// Reads the target hypothesis's cited Evidence (via node_source_refs),
// computes distinct source counts and highest source_authority_tier
// per polarity group deterministically (no LLM involvement), hands
// both the evidence AND the computed facts to confidenceSandbox.ts's
// V8 prompt/schema, then writes:
//   * validation_score + validation_computed_at_cluster_version
//     (ALWAYS on a successful, rule-clean run)
//   * status='deprecated', deprecation_reason='failed_validation'
//     (ONLY when score fails the configured gate threshold)
//
// The count + highest-tier computation happens HERE, not in the
// sandbox — same responsibility split V8 tested in the bench: any
// value the backend can compute deterministically must not be part
// of the model's output schema, because concurrent semantic and
// mechanical fields in the same schema keep contaminating each other
// on this model (see V3/V4/V7 failures in the prompt-variant bench).
//
// Nothing else. Per AI_AGENTS.md §7 + §18.2 write-scope matrix, this
// agent is the sole writer of validation_score anywhere in the system
// — no other agent may touch it. This narrow write scope is the whole
// reason the old single Validation Agent was split into Collector + Evaluator.
//
// Polarity source: reads node_source_refs.evidence_polarity (added in
// migration 003) to split citations into evidenceFor/evidenceAgainst
// before handing them to the sandbox. Validation Collector sets the
// column explicitly on write; every pre-migration row was backfilled
// to 'supporting' by the ADD COLUMN DEFAULT, which matched the actual
// classification of the graph at that moment (verified against
// Validation's last run report: 2 supporting / 0 contradicting).
//
// Deliberate scope boundary, worth flagging out loud (same "state
// limits up front" style as validationAgent.ts): this agent reads
// polarity from the node_source_refs column, NOT from graph-level
// supports/contradicts edges (GRAPH_SCHEMA.md §3, rows 6–7 of the
// edge type table). Those edges are reserved in the graph schema but
// deliberately unused for MVP — one column on an existing join table
// is smaller, reversible, and sufficient for the pipeline as it
// stands. If edge-native reasoning becomes valuable later (e.g. graph
// traversal queries that need to follow supports/contradicts as
// first-class edges), adding the edges is additive and won't require
// changing this agent — it can keep reading the column, and any new
// edge writer can maintain a mirror. Hypothesis Agent's write path is
// also intentionally untouched here — its citations are always
// evidence_for by its own contract (AI_AGENTS.md §5), so the DB
// default 'supporting' fills polarity implicitly without needing a
// code change.
import {
  runConfidenceSandbox,
  highestAuthorityTier,
  type ConfidenceEvidenceItem,
  type ConfidenceBackendFacts,
} from "../../sandbox/confidenceSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { hypothesisRepository } from "../../repositories/hypothesis.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

// Gate threshold. OPPORTUNITY_ENGINE.md §5.2 phrases the default as
// "net-positive after cluster and confidence weighting"; the sandbox
// schema clamps validation_score to [0, 1], so mapping "net-positive"
// onto that range gives 0.5 as the midpoint dividing net-negative from
// net-positive. Kept as a module constant, not a config lookup, until
// scoring_config gains a validation-gate column (out of MVP scope).
export const VALIDATION_GATE_THRESHOLD = 0.5;

export interface ConfidenceRunResult {
  validationScore: number | null;
  distinctSupportingSources: number | null;
  distinctContradictingSources: number | null;
  gatePassed: boolean | null;
  deprecatedForFailedValidation: boolean;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runConfidenceAgent(
  runId: string,
  hypothesisId: string,
  llm: LLMClient
): Promise<ConfidenceRunResult> {
  const hypothesis = await hypothesisRepository.findById(hypothesisId);
  if (!hypothesis || hypothesis.status !== "active") {
    return {
      validationScore: null,
      distinctSupportingSources: null,
      distinctContradictingSources: null,
      gatePassed: null,
      deprecatedForFailedValidation: false,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `hypothesis ${hypothesisId} not found or not active`,
    };
  }
  // Mode 1's input filter (AI_AGENTS.md §7): status='active' AND
  // validation_score IS NULL. Refuse to double-score.
  if (hypothesis.validationScore !== null) {
    return {
      validationScore: hypothesis.validationScore,
      distinctSupportingSources: null,
      distinctContradictingSources: null,
      gatePassed: hypothesis.validationScore >= VALIDATION_GATE_THRESHOLD,
      deprecatedForFailedValidation: false,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: `hypothesis ${hypothesisId} already has validation_score=${hypothesis.validationScore} — Confidence is idempotent-by-refusal on re-runs`,
    };
  }

  const refs = await prisma.nodeSourceRef.findMany({
    where: { nodeId: hypothesis.id, nodeType: "hypothesis" },
  });
  if (refs.length === 0) {
    return {
      validationScore: null,
      distinctSupportingSources: null,
      distinctContradictingSources: null,
      gatePassed: null,
      deprecatedForFailedValidation: false,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: "hypothesis has zero cited Evidence — nothing to score against",
    };
  }

  const evidenceRows = await prisma.evidence.findMany({
    where: { id: { in: refs.map((r) => r.evidenceId) }, status: "active" },
  });
  const polarityByEvidenceId = new Map(refs.map((r) => [r.evidenceId, r.evidencePolarity]));

  const toItem = (e: (typeof evidenceRows)[number]): ConfidenceEvidenceItem => ({
    id: e.id,
    sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
    sourceAuthorityTier: e.sourceAuthorityTier,
    text: e.extractedFact,
  });
  const evidenceFor: ConfidenceEvidenceItem[] = evidenceRows
    .filter((e) => polarityByEvidenceId.get(e.id) === "supporting")
    .map(toItem);
  const evidenceAgainst: ConfidenceEvidenceItem[] = evidenceRows
    .filter((e) => polarityByEvidenceId.get(e.id) === "contradicting")
    .map(toItem);

  // Traceability flag (DATABASE_SCHEMA.md §3.7 note) — max cluster_version
  // across the evidence this score was computed over. Reclustering
  // hasn't run yet in MVP, so this will be null across the board today;
  // that's a valid "computed pre-clustering" signal, not an error.
  const clusterVersions = evidenceRows
    .map((e) => e.clusterVersion)
    .filter((v): v is number => v !== null);
  const validationComputedAtClusterVersion =
    clusterVersions.length > 0 ? Math.max(...clusterVersions) : null;

  // Backend-computed facts, per V8 (see confidenceSandbox.ts header for
  // why these live here rather than in the model's output schema).
  // Both counts are Set().size over source_url_or_identifier — exact
  // same computation the bench used as "ground truth" through every
  // prior variant test. The highest-tier lookup uses the sandbox's
  // exported AUTHORITY_TIER_RANK so the ordering stays one source of
  // truth across sandbox and agent.
  const backendFacts: ConfidenceBackendFacts = {
    distinctSupportingSources: new Set(evidenceFor.map((e) => e.sourceUrlOrIdentifier)).size,
    distinctContradictingSources: new Set(evidenceAgainst.map((e) => e.sourceUrlOrIdentifier)).size,
    highestSupportingTier: highestAuthorityTier(evidenceFor),
    highestContradictingTier: highestAuthorityTier(evidenceAgainst),
  };

  return agentExecutionLogService.run(
    { runId, agentName: "Confidence", candidateId: null, modelUsed: (llm as { model?: string }).model ?? null },
    async () => {
      const result = await runConfidenceSandbox(llm, {
        hypothesisStatement: hypothesis.statement,
        evidenceFor,
        evidenceAgainst,
        backendFacts,
      });

      if (!result.parsed) {
        throw new Error(`Confidence Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          validationScore: null,
          distinctSupportingSources: null,
          distinctContradictingSources: null,
          gatePassed: null,
          deprecatedForFailedValidation: false,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      await hypothesisRepository.setValidationScore(
        hypothesis.id,
        result.parsed.validation_score,
        validationComputedAtClusterVersion
      );

      const gatePassed = result.parsed.validation_score >= VALIDATION_GATE_THRESHOLD;
      let deprecatedForFailedValidation = false;
      if (!gatePassed) {
        await hypothesisRepository.markFailedValidation(hypothesis.id);
        deprecatedForFailedValidation = true;
      }

      return {
        validationScore: result.parsed.validation_score,
        // These come from backendFacts now (not the model output), so
        // they're always reliable and always match ground truth.
        distinctSupportingSources: backendFacts.distinctSupportingSources,
        distinctContradictingSources: backendFacts.distinctContradictingSources,
        gatePassed,
        deprecatedForFailedValidation,
        boundedRuleViolations: [],
        skipped: false,
      };
    },
    // graph_mutation_count semantics: number of hypothesis-row column
    // writes committed. 1 for a passing-gate run (validation_score only),
    // 2 for a failing-gate run (validation_score + status/deprecation_reason).
    (result) =>
      result.skipped
        ? { graphMutationCount: 0 }
        : { graphMutationCount: result.deprecatedForFailedValidation ? 2 : 1 }
  );
}
