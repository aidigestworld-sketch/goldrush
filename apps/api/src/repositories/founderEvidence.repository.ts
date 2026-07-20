// Founder evidence table — append-only interview trail.
// Writes happen only through the Intake Engine; pipeline agents are read-only.
import { prisma } from "../db/client";
import type { MustFillField } from "../intake/founderIntakeState";

// The five target_field values mirror FounderFit's source_field enum
// exactly so comparison is direct without a mapping step.
const TARGET_FIELD_MAP: Record<MustFillField, string> = {
  expertise: "expertise",
  distributionAssets: "distribution_assets",
  capitalAvailability: "capital_availability",
  teamSize: "team_size",
  geography: "geography",
};

export interface CreateFounderEvidenceInput {
  founderId: string;
  targetField: MustFillField;
  questionAsked: string;
  rawAnswer: string;
  extractedValue: string;
}

export const founderEvidenceRepository = {
  async create(input: CreateFounderEvidenceInput) {
    return prisma.founderEvidence.create({
      data: {
        founderId: input.founderId,
        targetField: TARGET_FIELD_MAP[input.targetField],
        questionAsked: input.questionAsked,
        rawAnswer: input.rawAnswer,
        extractedValue: input.extractedValue,
      },
    });
  },

  // Load all evidence for a founder in creation order. Used by the
  // deriver to re-compute profile columns, and by FounderFit to build
  // the grounding set for matched_strength citation.
  async findByFounderId(founderId: string) {
    return prisma.founderEvidence.findMany({
      where: { founderId },
      orderBy: { createdAt: "asc" },
    });
  },

  // Load evidence for a specific field only — used when re-deriving a
  // single field after a new answer is recorded.
  async findByFounderIdAndField(founderId: string, targetField: MustFillField) {
    return prisma.founderEvidence.findMany({
      where: { founderId, targetField: TARGET_FIELD_MAP[targetField] },
      orderBy: { createdAt: "asc" },
    });
  },
};
