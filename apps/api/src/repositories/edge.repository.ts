// Generic edge writer — DATABASE_SCHEMA.md §6.1. Every agent that
// writes edges (Expansion: has_audience/experiences; CompetitiveAnalysis:
// addressed_by/competes_with/monetizes_via; FounderFit:
// fits/does_not_fit) goes through this one repository rather than
// each rolling its own insert.
import { prisma } from "../db/client";

export type EdgeType =
  | "has_audience"
  | "experiences"
  | "addressed_by"
  | "competes_with"
  | "monetizes_via"
  | "fits"
  | "does_not_fit";

export const edgeRepository = {
  create(edgeType: EdgeType, fromId: string, fromType: string, toId: string, toType: string) {
    return prisma.edge.create({
      data: { edgeType, fromId, fromType, toId, toType },
    });
  },
};
