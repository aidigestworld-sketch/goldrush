// Extractor for the Confidence Mode 2 pre-design audit.
//
// Task: for each active opportunity_candidate, dump raw data — do NOT
// aggregate coverage/agreement/freshness here. That's the bench call
// the reviewer will make in chat.
//
// Per-candidate shape (per user spec):
//   {
//     candidate_id, hypothesis_id, opportunity_quality, founder_fit_score,
//     composition_rows: [
//       { field_name, value, is_null, source_refs }
//     ],
//     linked_evidence: [
//       { evidence_id, source_type, evidence_polarity, timestamp, text_excerpt, source_ref }
//     ]
//   }
//
// composition_rows semantics (5 rows per candidate):
//   field_name    = role (market | audience | problem | hypothesis | business_model)
//   value         = node id (uuid string)
//   is_null       = true when Composition's traversal did NOT produce
//                   a row for this role (defensive — Composition
//                   Agent's §8 invariant currently rejects the whole
//                   run if any role is missing, so in practice this
//                   should stay false everywhere; kept for the audit
//                   in case a candidate exists with an incomplete
//                   composition set)
//   source_refs   = evidence ids cited on that node (via
//                   node_source_refs, filtered to the node's type)
//
// linked_evidence: the UNION of source_refs from the composition_rows
// above, dereferenced. text_excerpt is trimmed to first 300 chars per
// spec.
//
// Read-only. No schema changes. No LLM calls.
// Run: npx tsx -r dotenv/config src/scripts/extractConfidenceMode2AuditData.ts
import * as fs from "fs";
import * as path from "path";
import { prisma } from "../db/client";

const COMPOSITION_ROLES = ["market", "audience", "problem", "hypothesis", "business_model"] as const;
type Role = (typeof COMPOSITION_ROLES)[number];

interface CompositionRow {
  field_name: Role;
  value: string | null;
  is_null: boolean;
  source_refs: { evidence_id: string; evidence_polarity: string }[];
}

interface LinkedEvidence {
  evidence_id: string;
  source_type: string;
  evidence_polarity: string;
  timestamp: string;
  text_excerpt: string;
  source_ref: string;
  node_id: string;
  node_type: string;
}

interface CandidateAuditRecord {
  candidate_id: string;
  hypothesis_id: string | null;
  opportunity_quality: number | null;
  founder_fit_score: number | null;
  composition_rows: CompositionRow[];
  linked_evidence: LinkedEvidence[];
}

async function main() {
  const candidates = await prisma.opportunityCandidate.findMany({
    orderBy: { createdAt: "asc" },
  });
  console.log(`Found ${candidates.length} opportunity_candidate rows`);

  const audit: CandidateAuditRecord[] = [];

  for (const cand of candidates) {
    const compositionRowsRaw = await prisma.opportunityCandidateComposition.findMany({
      where: { candidateId: cand.id },
    });
    const byRole = new Map<Role, { nodeId: string; nodeType: string } | null>();
    for (const role of COMPOSITION_ROLES) {
      const match = compositionRowsRaw.find((r) => r.role === role);
      byRole.set(role, match ? { nodeId: match.nodeId, nodeType: match.nodeType } : null);
    }

    // For each present composition row, pull its node_source_refs.
    // node_source_refs has a composite PK (nodeId, evidenceId); the row
    // also carries evidence_polarity. Different node types share this
    // one table, distinguished by node_type.
    const composition_rows: CompositionRow[] = [];
    const allEvidenceIds = new Set<string>();
    // node_id → array of refs for building linked_evidence
    const refsByNode = new Map<string, { evidenceId: string; nodeType: string; polarity: string }[]>();

    for (const role of COMPOSITION_ROLES) {
      const entry = byRole.get(role);
      if (!entry) {
        composition_rows.push({ field_name: role, value: null, is_null: true, source_refs: [] });
        continue;
      }
      const refs = await prisma.nodeSourceRef.findMany({
        where: { nodeId: entry.nodeId, nodeType: entry.nodeType },
      });
      composition_rows.push({
        field_name: role,
        value: entry.nodeId,
        is_null: false,
        source_refs: refs.map((r) => ({
          evidence_id: r.evidenceId,
          evidence_polarity: r.evidencePolarity,
        })),
      });
      refsByNode.set(
        entry.nodeId,
        refs.map((r) => ({ evidenceId: r.evidenceId, nodeType: entry.nodeType, polarity: r.evidencePolarity }))
      );
      for (const r of refs) allEvidenceIds.add(r.evidenceId);
    }

    // Deref evidence. Preserve node origin (which node cited this
    // evidence) so the audit can see the same evidence potentially
    // appearing multiple times across nodes.
    const evidenceRows = await prisma.evidence.findMany({
      where: { id: { in: [...allEvidenceIds] } },
    });
    const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));

    const linked_evidence: LinkedEvidence[] = [];
    for (const [nodeId, refs] of refsByNode) {
      for (const r of refs) {
        const e = evidenceById.get(r.evidenceId);
        if (!e) continue;
        linked_evidence.push({
          evidence_id: e.id,
          source_type: e.sourceType,
          evidence_polarity: r.polarity,
          timestamp: e.fetchedAt.toISOString(),
          text_excerpt: e.extractedFact.substring(0, 300),
          source_ref: e.sourceUrlOrIdentifier,
          node_id: nodeId,
          node_type: r.nodeType,
        });
      }
    }

    const hypothesisEntry = byRole.get("hypothesis");
    audit.push({
      candidate_id: cand.id,
      hypothesis_id: hypothesisEntry?.nodeId ?? null,
      opportunity_quality: cand.opportunityQuality,
      founder_fit_score: cand.founderFitScore,
      composition_rows,
      linked_evidence,
    });
  }

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "confidence_mode2_audit_data.json");
  fs.writeFileSync(outFile, JSON.stringify(audit, null, 2));
  console.log(`Wrote ${audit.length} candidate records to ${outFile}`);

  const summary = audit.map((c) => ({
    candidate_id: c.candidate_id,
    hypothesis_id: c.hypothesis_id,
    opportunity_quality: c.opportunity_quality,
    founder_fit_score: c.founder_fit_score,
    composition_rows_total: c.composition_rows.length,
    composition_rows_null: c.composition_rows.filter((r) => r.is_null).length,
    linked_evidence_count: c.linked_evidence.length,
    distinct_evidence_count: new Set(c.linked_evidence.map((e) => e.evidence_id)).size,
    distinct_source_types: [...new Set(c.linked_evidence.map((e) => e.source_type))],
    polarity_split: {
      supporting: c.linked_evidence.filter((e) => e.evidence_polarity === "supporting").length,
      contradicting: c.linked_evidence.filter((e) => e.evidence_polarity === "contradicting").length,
    },
  }));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
