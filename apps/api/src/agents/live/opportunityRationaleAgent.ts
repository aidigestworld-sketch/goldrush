// Opportunity Rationale Agent — post-promotion phrasing sub-step.
//
// Runs AFTER Compression has already promoted a candidate and inserted
// the Opportunity row with empty rationale_bullets / risk_summary
// arrays. This is a SEPARATE, subsequent transaction — deliberately
// not blocking Compression's promotion path, matching the existing
// architecture note (compressionAgent.ts header, "rationale_bullets/
// risk_summary are inserted as empty arrays here").
//
// Writes ONLY: UPDATE opportunity SET rationale_bullets=..., risk_summary=...
// WHERE id=<promoted_opportunity_id>. Never touches any other column,
// never touches candidate/composition/evidence.
//
// Idempotency: refuses to overwrite non-empty rationale_bullets or
// risk_summary — same idempotent-by-refusal pattern Composition and
// Scoring use. Manual re-run is possible by nulling those columns
// first if a fresh draft is wanted.

import type { LLMClient } from "../../sandbox/llmClient";
import {
  runOpportunityRationaleSandbox,
  COMPOSITION_FIELD_WHITELIST,
  type OpportunityRationaleInput,
} from "../../sandbox/opportunityRationaleSandbox";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";
import { prisma } from "../../db/client";

export interface OpportunityRationaleRunResult {
  opportunityId: string;
  rationaleBullets: string[];
  riskSummary: string[];
  groundingViolations: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runOpportunityRationaleAgent(
  runId: string,
  opportunityId: string,
  llm: LLMClient
): Promise<OpportunityRationaleRunResult> {
  const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opportunity) {
    return skip(opportunityId, `opportunity ${opportunityId} not found`);
  }
  if (opportunity.rationaleBullets.length > 0 || opportunity.riskSummary.length > 0) {
    return skip(
      opportunityId,
      `opportunity ${opportunityId} already has rationale_bullets/risk_summary populated — idempotent-by-refusal`
    );
  }

  const candidate = await prisma.opportunityCandidate.findUnique({
    where: { id: opportunity.promotedFromCandidateId },
  });
  if (!candidate) return skip(opportunityId, `promoted candidate ${opportunity.promotedFromCandidateId} missing`);

  // Composition slots — read the actual node rows and only expose the
  // whitelisted columns to the sandbox. This is where the "model can
  // only see real data" contract is enforced at the read layer.
  const compRows = await prisma.opportunityCandidateComposition.findMany({
    where: { candidateId: candidate.id },
  });
  const composition: OpportunityRationaleInput["composition"] = [];
  const nullCompositionFields: string[] = [];
  for (const c of compRows) {
    if (!(c.role in COMPOSITION_FIELD_WHITELIST)) continue;
    const role = c.role as keyof typeof COMPOSITION_FIELD_WHITELIST;
    const row = await loadCompositionRow(role, c.nodeId);
    if (!row) continue;
    const projected: Record<string, unknown> = {};
    for (const field of COMPOSITION_FIELD_WHITELIST[role]) {
      const camel = snakeToCamel(field);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const val = (row as any)[camel] ?? (row as any)[field] ?? null;
      projected[field] = val;
      if (val === null || val === undefined) nullCompositionFields.push(`${role}.${field}`);
    }
    composition.push({ role, node: projected });
  }

  // Evidence — every node_source_ref cited on any of the candidate's
  // composition slots. Preserve polarity so the model can mention
  // supporting vs contradicting citations correctly.
  const nodeIds = compRows.map((c) => c.nodeId);
  const refs = await prisma.nodeSourceRef.findMany({ where: { nodeId: { in: nodeIds } } });
  const evidenceIds = [...new Set(refs.map((r) => r.evidenceId))];
  const evidenceRows = await prisma.evidence.findMany({ where: { id: { in: evidenceIds } } });
  const polarityByEvidenceId = new Map<string, "supporting" | "contradicting">();
  for (const r of refs) {
    // If any ref for this evidence is contradicting, treat it as contradicting.
    const existing = polarityByEvidenceId.get(r.evidenceId);
    if (r.evidencePolarity === "contradicting") {
      polarityByEvidenceId.set(r.evidenceId, "contradicting");
    } else if (!existing) {
      polarityByEvidenceId.set(r.evidenceId, "supporting");
    }
  }
  const evidence: OpportunityRationaleInput["evidence"] = evidenceRows.map((e) => ({
    id: e.id,
    sourceType: e.sourceType,
    extractedFact: e.extractedFact,
    polarity: polarityByEvidenceId.get(e.id) ?? "supporting",
  }));
  const contradictingCount = [...polarityByEvidenceId.values()].filter((p) => p === "contradicting").length;

  // FounderFit gaps — parsed out of the founder_fit_rationale text.
  // The rationale is unstructured English; the best we can do is
  // extract any "gap" mentions the model wrote. This is heuristic on
  // purpose — if it misses, worst case the risk_summary generator
  // just doesn't flag a founder-fit gap explicitly.
  const founderFitGaps = extractGapsFromRationale(candidate.founderFitRationale ?? "");

  // P1.2 (category 2): opportunityQuality / confidenceScore /
  // founderFitScore reaching Rationale as null means Compression's own
  // promotion-transaction invariant was violated — Compression only
  // writes an Opportunity row when all three components are non-null on
  // the winner candidate (compressionAgent.ts's ready-check +
  // opportunity.confidence_score/founder_fit_score are NOT NULL columns
  // sourced from winnerRow.confidenceScore!/founderFitScore!). Silently
  // coalescing to 0 here would let the rationale LLM emit a customer-
  // visible bullet like "confidence_score is 0.00 (extremely low)" for
  // a value that was actually never computed. Throw loud so the failure
  // points at Compression rather than corrupting the phrasing.
  if (candidate.opportunityQuality === null) {
    throw new Error(
      `OpportunityRationale received null candidate.opportunityQuality for promoted candidate ${candidate.id} ` +
        `(opportunity ${opportunityId}) — Compression's promotion invariant was violated. ` +
        `Investigate any code path that inserts an Opportunity row without going through runCompressionAgent's ` +
        `promotion transaction (compressionAgent.ts).`
    );
  }
  if (candidate.confidenceScore === null) {
    throw new Error(
      `OpportunityRationale received null candidate.confidenceScore for promoted candidate ${candidate.id} ` +
        `(opportunity ${opportunityId}) — Compression's promotion invariant was violated. ` +
        `Investigate any code path that inserts an Opportunity row without going through runCompressionAgent's ` +
        `promotion transaction (compressionAgent.ts).`
    );
  }
  if (candidate.founderFitScore === null) {
    throw new Error(
      `OpportunityRationale received null candidate.founderFitScore for promoted candidate ${candidate.id} ` +
        `(opportunity ${opportunityId}) — Compression's promotion invariant was violated. ` +
        `Investigate any code path that inserts an Opportunity row without going through runCompressionAgent's ` +
        `promotion transaction (compressionAgent.ts).`
    );
  }

  const input: OpportunityRationaleInput = {
    candidate: {
      id: candidate.id,
      opportunityQuality: candidate.opportunityQuality,
      confidenceScore: candidate.confidenceScore,
      founderFitScore: candidate.founderFitScore,
      ventureScore: opportunity.ventureScore,
      founderFitRationale: candidate.founderFitRationale ?? null,
    },
    composition,
    evidence,
    signals: {
      contradictingEvidenceCount: contradictingCount,
      nullCompositionFields,
      founderFitGaps,
    },
  };

  return agentExecutionLogService.run(
    { runId, agentName: "OpportunityRationale", candidateId: candidate.id, modelUsed: (llm as { model?: string }).model ?? null },
    async () => {
      const result = await runOpportunityRationaleSandbox(llm, input);

      if (!result.parsed) {
        throw new Error(
          `OpportunityRationale output failed schema validation: ${result.validationErrors.join("; ")}`
        );
      }
      if (result.groundingViolations.length > 0) {
        // No partial output — reject the whole batch if the model
        // invented any citation. Same rule as Discovery/Expansion/
        // Hypothesis when the Bounded Rule fails.
        return {
          opportunityId,
          rationaleBullets: [],
          riskSummary: [],
          groundingViolations: result.groundingViolations,
          skipped: true,
          skipReason: "grounding violations found — nothing written",
        };
      }

      // Persist bullets as plain-text arrays on the opportunity row.
      // We keep the source_ref inline in the stored text (as a
      // suffix) so a downstream reader still sees the citation — a
      // separate structured column would be cleaner but is out of
      // scope for this task and would need its own migration.
      const rationaleBullets = result.parsed.rationale_bullets.map(
        (b) => `${b.text} [${b.source_ref}]`
      );
      const riskSummary = result.parsed.risk_summary.map((b) => `${b.text} [${b.source_ref}]`);

      await prisma.opportunity.update({
        where: { id: opportunityId },
        data: { rationaleBullets, riskSummary },
      });

      return {
        opportunityId,
        rationaleBullets,
        riskSummary,
        groundingViolations: [],
        skipped: false,
      };
    }
  );
}

function skip(opportunityId: string, reason: string): OpportunityRationaleRunResult {
  return {
    opportunityId,
    rationaleBullets: [],
    riskSummary: [],
    groundingViolations: [],
    skipped: true,
    skipReason: reason,
  };
}

async function loadCompositionRow(
  role: keyof typeof COMPOSITION_FIELD_WHITELIST,
  nodeId: string
) {
  if (role === "market") return prisma.market.findUnique({ where: { id: nodeId } });
  if (role === "audience") return prisma.audience.findUnique({ where: { id: nodeId } });
  if (role === "problem") return prisma.problem.findUnique({ where: { id: nodeId } });
  if (role === "hypothesis") return prisma.hypothesis.findUnique({ where: { id: nodeId } });
  if (role === "business_model") return prisma.businessModel.findUnique({ where: { id: nodeId } });
  return null;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

// Heuristic gap extractor: FounderFit's rationale is free text, but
// the sandbox spec always includes explicit "gap" wording. Match any
// sentence containing "gap" or "would need" or "lacks" — coarse, but
// good enough as a signal-source for the risk_summary generator.
function extractGapsFromRationale(rationale: string): string[] {
  if (!rationale) return [];
  const sentences = rationale.split(/(?<=[.!?])\s+/);
  return sentences
    .filter((s) => /\b(gap|gaps|would need|lacks|no [a-z]+ (?:experience|expertise)|missing)\b/i.test(s))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5);
}
