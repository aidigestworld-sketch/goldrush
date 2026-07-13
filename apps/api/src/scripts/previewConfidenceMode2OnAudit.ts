// Preview run: apply computeConfidenceMode2 (pure function, NO writes)
// to the 4 real audit candidates and print what the mode-2 output
// WOULD BE if the formulas were accepted as-is. Nothing lands in the
// database. This is the concrete check-your-work artifact for the
// reviewer before the confidenceMode2 formulas get locked in and
// wired to the live agent path.
//
// Run: npx tsx -r dotenv/config src/scripts/previewConfidenceMode2OnAudit.ts
import { computeConfidenceMode2, COMPOSITION_ROLES, type CompositionSlot, type ConfidenceMode2Input } from "../agents/confidenceMode2";
import auditFixture from "./output/confidence_mode2_audit_data.json";

interface FixtureCandidate {
  candidate_id: string;
  hypothesis_id: string | null;
  opportunity_quality: number | null;
  founder_fit_score: number | null;
  composition_rows: {
    field_name: string;
    value: string | null;
    is_null: boolean;
    source_refs: { evidence_id: string; evidence_polarity: string }[];
  }[];
  linked_evidence: {
    evidence_id: string;
    source_type: string;
    evidence_polarity: string;
    timestamp: string;
    text_excerpt: string;
    source_ref: string;
    node_id: string;
    node_type: string;
  }[];
}

function fixtureToInput(c: FixtureCandidate, now: Date): ConfidenceMode2Input {
  const slots: CompositionSlot[] = COMPOSITION_ROLES.map<CompositionSlot>((role) => {
    const row = c.composition_rows.find((r) => r.field_name === role);
    if (!row) return { role, isNull: true, sourceRefs: [] };
    return {
      role,
      isNull: row.is_null,
      sourceRefs: row.source_refs.map((r) => ({
        evidenceId: r.evidence_id,
        evidencePolarity: r.evidence_polarity as "supporting" | "contradicting",
      })),
    };
  });
  const seen = new Map<string, Date>();
  for (const e of c.linked_evidence) {
    if (!seen.has(e.evidence_id)) seen.set(e.evidence_id, new Date(e.timestamp));
  }
  const evidence = [...seen].map(([evidenceId, fetchedAt]) => ({ evidenceId, fetchedAt, sourcePublishedAt: null }));
  return { slots, evidence, now };
}

const now = new Date();
console.log(`Preview @ ${now.toISOString()} — no DB writes anywhere in this script.\n`);

for (const c of auditFixture as FixtureCandidate[]) {
  const out = computeConfidenceMode2(fixtureToInput(c, now));
  console.log(`--- candidate ${c.candidate_id} (hyp ${c.hypothesis_id?.substring(0, 8)}) ---`);
  console.log(
    JSON.stringify(
      {
        coverage_gate: out.coverageGate,
        incomplete_composition: out.incompleteComposition,
        agreement: out.agreement === null ? null : Number(out.agreement.toFixed(6)),
        // freshness is surfaced for visibility but does NOT enter
        // confidence_score in the revised formula — see confidenceMode2.ts.
        freshness_debug_only_not_blended: out.freshness === null ? null : Number(out.freshness.toFixed(6)),
        confidence_score: out.confidenceScore === null ? null : Number(out.confidenceScore.toFixed(6)),
        slot_evidence_counts: out.slotEvidenceCounts.map((sec) => ({
          role: sec.role,
          supporting: sec.distinctSupportingCount,
          contradicting: sec.distinctContradictingCount,
        })),
      },
      null,
      2
    )
  );
}
