-- Widens founder_evidence_target_field_check to accept the two new MUST-fill
-- fields wired into the Intake Engine + FounderFit grounding: team_size and
-- geography. The three original values (expertise, distribution_assets,
-- capital_availability) remain valid.
--
-- Founder.team_size (int?) and Founder.geography (text?) already exist on the
-- founder table since migration 001 — no column adds needed. Only the
-- founder_evidence.target_field enum-in-a-CHECK needs to catch up.
--
-- Run against app DB (src/db/migrations/, manual apply — same stream as 013).

BEGIN;

ALTER TABLE founder_evidence
  DROP CONSTRAINT founder_evidence_target_field_check;

ALTER TABLE founder_evidence
  ADD CONSTRAINT founder_evidence_target_field_check
    CHECK (target_field IN (
      'expertise',
      'distribution_assets',
      'capital_availability',
      'team_size',
      'geography'
    ));

COMMIT;
