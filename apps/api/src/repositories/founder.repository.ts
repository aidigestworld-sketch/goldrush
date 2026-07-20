// Founder table access — FounderFit Agent's read target (AI_AGENTS.md §9)
// and the Intake Engine's write target.
//
// Founder is self-declared user data, exempt from source_refs
// (§2.8 / DATABASE_SCHEMA.md §3.8). Pipeline agents (FounderFit et al.)
// remain read-only. The Intake Engine is the only write path.
import { prisma } from "../db/client";
import type { FounderIntakeState, MustFillField } from "../intake/founderIntakeState";
import { founderEvidenceRepository } from "./founderEvidence.repository";
import { deriveProfileFromEvidence, type EvidenceRow } from "../intake/founderProfileDeriver";

export interface IntakeEvidenceInput {
  targetField: MustFillField;
  questionAsked: string;
  rawAnswer: string;
  extractedValue: string;
}

export const founderRepository = {
  findById(id: string) {
    return prisma.founder.findUnique({ where: { id } });
  },

  // Persist one intake turn atomically:
  //   1. INSERT founder_evidence row (the interview answer)
  //   2. Re-derive all profile columns from the full evidence trail
  //   3. UPDATE founder (profile columns + intake_state)
  //
  // Steps 2+3 run in a transaction so the denormalized profile columns
  // and the evidence table are never out of sync. Step 1 (the evidence
  // insert) runs before the transaction; if it fails, the founder row
  // is not touched — the turn is cleanly rolled back.
  async saveIntakeTurn(
    id: string,
    intakeState: FounderIntakeState,
    evidence: IntakeEvidenceInput
  ) {
    // Write the immutable evidence row first.
    await founderEvidenceRepository.create({
      founderId: id,
      targetField: evidence.targetField,
      questionAsked: evidence.questionAsked,
      rawAnswer: evidence.rawAnswer,
      extractedValue: evidence.extractedValue,
    });

    // Re-derive profile columns from the now-complete evidence trail.
    const allEvidence = await founderEvidenceRepository.findByFounderId(id);
    const derived = deriveProfileFromEvidence(allEvidence as EvidenceRow[]);

    return prisma.founder.update({
      where: { id },
      data: {
        expertise: derived.expertise,
        distributionAssets: derived.distributionAssets,
        capitalAvailability: derived.capitalAvailability,
        teamSize: derived.teamSize,
        geography: derived.geography,
        intakeState: intakeState as object,
        lastUpdatedAt: new Date(),
      },
    });
  },
};
