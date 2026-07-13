// Generic evidence-citation writer, shared across Discovery/Expansion/
// CompetitiveAnalysis/Hypothesis/Validation (AI_AGENTS.md §14 —
// node_source_refs is a shared write target, unlike single-owner
// tables). node_type here is app-enforced against
// GRAPH_SCHEMA.md's set — DB CHECK constraint on node_type is the
// second line of defense (001_initial_schema.sql).
//
// evidencePolarity is optional at the API level and defaults to
// 'supporting' at the DB level (migration 003). This shape is
// deliberate: Hypothesis Agent's write path (AI_AGENTS.md §5) only
// ever cites evidence_for by contract, so it can — and does — omit
// the field and take the default. Validation Collector's write path
// (§6) classifies each citation and MUST pass the value explicitly so
// contradictions actually round-trip through the DB. Discovery/
// Expansion/CompetitiveAnalysis all cite Evidence in a
// structural-establishment sense ("this row is here because of this
// source"), never in a for/against sense, so they too take the
// default.
import { prisma } from "../db/client";

export type SourceRefNodeType = "market" | "audience" | "problem" | "existing_solution" | "business_model" | "hypothesis";
export type EvidencePolarity = "supporting" | "contradicting";

export const nodeSourceRefRepository = {
  createMany(
    refs: { nodeId: string; nodeType: SourceRefNodeType; evidenceId: string; evidencePolarity?: EvidencePolarity }[]
  ) {
    if (refs.length === 0) return Promise.resolve({ count: 0 });
    return prisma.nodeSourceRef.createMany({
      data: refs.map((r) => ({
        nodeId: r.nodeId,
        nodeType: r.nodeType,
        evidenceId: r.evidenceId,
        // Omit the key entirely when the caller didn't specify —
        // Postgres's NOT NULL DEFAULT 'supporting' clause fills it in.
        // Explicitly setting undefined would also work with Prisma,
        // but omission makes the "we're relying on the DB default"
        // path visible to a reader.
        ...(r.evidencePolarity ? { evidencePolarity: r.evidencePolarity } : {}),
      })),
      skipDuplicates: true,
    });
  },
};
