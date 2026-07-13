// Real Hypothesis Agent — Phase 5. Reads a real Problem and its
// connected ExistingSolutions (via addressed_by edges — already
// created by CompetitiveAnalysis's live runs), calls the LLM using
// hypothesisSandbox.ts's validated prompt/schema/Bounded-Synthesis
// checks, writes Hypothesis + hypothesis_sources + node_source_refs.
// Nothing else (AI_AGENTS.md §5/§18.1 — owns: hypothesis).
import { runHypothesisSandbox, type HypothesisSandboxInput } from "../../sandbox/hypothesisSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { hypothesisRepository } from "../../repositories/hypothesis.repository";
import { hypothesisSourcesRepository } from "../../repositories/hypothesisSources.repository";
import { nodeSourceRefRepository } from "../../repositories/nodeSourceRef.repository";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { computeSupportingEvidenceStrength } from "../evidenceStrength";
import { prisma } from "../../db/client";

export interface HypothesisRunResult {
  hypothesesCreated: number;
  boundedRuleViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runHypothesisAgent(runId: string, problemId: string, llm: LLMClient): Promise<HypothesisRunResult> {
  const problem = await prisma.problem.findUnique({ where: { id: problemId } });
  if (!problem || problem.status !== "active") {
    return { hypothesesCreated: 0, boundedRuleViolations: [], skipped: true, skipReason: `problem ${problemId} not found or not active` };
  }

  // Find ExistingSolutions connected to this Problem via addressed_by
  const addressedByEdges = await prisma.edge.findMany({
    where: { edgeType: "addressed_by", fromId: problem.id, fromType: "problem" },
  });
  const existingSolutionIds = addressedByEdges.map((e) => e.toId);
  const existingSolutions = await prisma.existingSolution.findMany({
    where: { id: { in: existingSolutionIds }, status: "active" },
  });

  if (existingSolutions.length === 0) {
    return {
      hypothesesCreated: 0,
      boundedRuleViolations: [],
      skipped: true,
      skipReason: "no active ExistingSolution connected to this Problem via addressed_by — run CompetitiveAnalysis first",
    };
  }

  // Gather evidence backing the Problem and the ExistingSolutions, via
  // node_source_refs — this is the citable material Hypothesis may
  // reference in evidence_for/evidence_against.
  const problemRefs = await prisma.nodeSourceRef.findMany({ where: { nodeId: problem.id, nodeType: "problem" } });
  const solutionRefs = await prisma.nodeSourceRef.findMany({
    where: { nodeId: { in: existingSolutionIds }, nodeType: "existing_solution" },
  });
  const evidenceIds = [...new Set([...problemRefs, ...solutionRefs].map((r) => r.evidenceId))];
  const evidenceRows = await prisma.evidence.findMany({ where: { id: { in: evidenceIds } } });

  const sandboxInput: HypothesisSandboxInput = {
    problem: {
      id: problem.id,
      label: problem.label ?? "",
      problemMaturity: problem.problemMaturity,
      currentWorkaroundDescription: problem.currentWorkaroundDescription,
    },
    existingSolutions: existingSolutions.map((s) => ({
      id: s.id,
      label: s.label ?? "",
      positioningSummary: s.positioningSummary,
      pricingSummary: (s.pricingModel as { summary?: string } | null)?.summary ?? null,
    })),
    evidence: evidenceRows.map((e) => ({ id: e.id, sourceUrlOrIdentifier: e.sourceUrlOrIdentifier, text: e.extractedFact })),
  };

  return agentExecutionLogService.run(
    { runId, agentName: "Hypothesis", modelUsed: (llm as { model?: string }).model ?? null },
    async () => {
      const result = await runHypothesisSandbox(llm, sandboxInput);

      if (!result.parsed) {
        throw new Error(`Hypothesis Agent output failed schema validation: ${result.validationErrors.join("; ")}`);
      }
      if (result.boundedRuleViolations.length > 0) {
        return {
          hypothesesCreated: 0,
          boundedRuleViolations: result.boundedRuleViolations,
          skipped: true,
          skipReason: "Bounded Rule violations found — nothing written",
        };
      }

      let hypothesesCreated = 0;
      // Map from a cited id (Problem/ExistingSolution/Evidence id) back
      // to which role it plays, for wiring hypothesis_sources correctly.
      const validSolutionIds = new Set(existingSolutions.map((s) => s.id));

      // Per-evidence-row lookup so we can pull each cited evidence's
      // authority tier + source identifier for the deterministic
      // supportingEvidenceStrength computation.
      const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));

      for (const h of result.parsed.hypotheses) {
        // P3.1 grounding: supportingEvidenceStrength is a deterministic
        // tier-weighted score over the evidence this specific
        // hypothesis cited in evidence_for — NOT the LLM's own
        // confidence in the hypothesis. The LLM's self-confidence
        // (h.confidence) goes to a separate `confidence` column for
        // observability, and is never read by Scoring. See
        // evidenceStrength.ts header for the audit history.
        const citedEvidence = h.evidence_for
          .map((id) => evidenceById.get(id))
          .filter((e): e is (typeof evidenceRows)[number] => e !== undefined);
        const supportingEvidenceStrength = computeSupportingEvidenceStrength(
          citedEvidence.map((e) => ({
            sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
            sourceAuthorityTier: e.sourceAuthorityTier,
          }))
        );

        const created = await hypothesisRepository.create({
          statement: h.statement,
          gapType: h.gap_type,
          missingData: h.missing_data,
          supportingEvidenceStrength,
          confidence: h.confidence,
          pipelineRunId: runId,
        });

        // hypothesis_sources: link to the Problem always, and to
        // whichever cited ExistingSolution(s) this hypothesis actually
        // references (nullable existing_solution_id if none cited —
        // "cites an absence of solution coverage").
        const citedSolutionIds = h.existing_solutions_considered.filter((id) => validSolutionIds.has(id));
        if (citedSolutionIds.length === 0) {
          await hypothesisSourcesRepository.create(created.id, problem.id, null);
        } else {
          for (const solutionId of citedSolutionIds) {
            await hypothesisSourcesRepository.create(created.id, problem.id, solutionId);
          }
        }

        // node_source_refs: cite the actual Evidence rows referenced
        // (filter out Problem/ExistingSolution ids, which aren't Evidence)
        const evidenceCitations = h.evidence_for.filter((id) => evidenceIds.includes(id));
        await nodeSourceRefRepository.createMany(
          evidenceCitations.map((evidenceId) => ({ nodeId: created.id, nodeType: "hypothesis" as const, evidenceId }))
        );

        hypothesesCreated++;
      }

      return { hypothesesCreated, boundedRuleViolations: [], skipped: false };
    },
    (result) => ({ graphMutationCount: result.hypothesesCreated })
  );
}
