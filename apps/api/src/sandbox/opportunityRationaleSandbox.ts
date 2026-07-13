// Opportunity Rationale Sandbox — post-promotion LLM phrasing sub-step.
//
// Design mirrors FounderFit's grounding discipline: every generated
// bullet MUST carry a `source_ref` naming exactly which piece of the
// candidate's data it phrases. Two source_ref kinds are permitted:
//   1. "composition:<role>:<field>" — a specific field on a specific
//      composition slot (e.g. "composition:market:growth_rate_estimate",
//      "composition:business_model:operational_complexity_estimate").
//      The value MUST be a real field name present on that node type.
//   2. "evidence:<uuid>" — a specific Evidence row cited via
//      node_source_refs on any of the candidate's composition slots.
//      The uuid MUST be in the allowed set the caller passes in.
//
// Post-parse grounding check: for each bullet's source_ref, verify the
// referenced field or evidence id actually exists in the input the
// model was shown. Any violation rejects the whole batch — same
// no-partial-output rule Discovery/Expansion/Hypothesis use.
//
// This is where language generation genuinely belongs. Confidence
// Mode 2 turned out to be pure computation; rationale/risk phrasing
// is intrinsically prose. The prompt discipline is the guardrail:
// the model can rearrange, summarize, and connect the given facts,
// but it cannot introduce a claim not backed by them.

import { z } from "zod";
import type { LLMClient } from "./llmClient";

// Whitelist of field names per composition role. A bullet claiming
// "composition:market:some_made_up_field" fails grounding because
// some_made_up_field isn't in this list. The reader can trust every
// composition:X:Y bullet points at a real DB column.
export const COMPOSITION_FIELD_WHITELIST: Record<string, readonly string[]> = {
  market: [
    "label",
    "market_size_estimate",
    "growth_rate_estimate",
    "maturity_stage",
    "confidence",
  ],
  audience: [
    "label",
    "willingness_to_pay_signal",
    "acquisition_channels_known",
    "confidence",
  ],
  problem: [
    "label",
    "severity_signal",
    "frequency_signal",
    "problem_maturity",
    "current_workaround_description",
    "confidence",
  ],
  // Semantic hints for the model's phrasing, so bullets citing these
  // fields describe them accurately (see the "Phrasing preference" and
  // FIELD SEMANTICS blocks in SYSTEM_PROMPT):
  //   * validation_score: [0,1] Confidence Agent's LLM-mediated,
  //     banded semantic-judgment score (AI_AGENTS.md §7).
  //   * supporting_evidence_strength: [0,1] DETERMINISTIC tier-weighted
  //     score over the hypothesis's cited supporting evidence — high
  //     means many/high-authority sources back it, NOT that the LLM was
  //     confident about it. See agents/evidenceStrength.ts.
  //   * confidence: [0,1] LLM's own self-reported confidence in the
  //     hypothesis statement. Observability signal only — NOT read by
  //     Scoring. Phrase as a self-report, not an external validation.
  hypothesis: [
    "statement",
    "validation_score",
    "supporting_evidence_strength",
    "confidence",
  ],
  business_model: [
    "label",
    "margin_profile",
    "operational_complexity_estimate",
    "capital_intensity_estimate",
    "monetization_mechanism",
  ],
};

const BulletSchema = z.object({
  text: z.string().min(8).max(300),
  source_ref: z.string().min(3),
});

const RationaleOutputSchema = z.object({
  rationale_bullets: z.array(BulletSchema).min(3).max(5),
  risk_summary: z.array(BulletSchema).min(2).max(4),
});

export type RationaleOutput = z.infer<typeof RationaleOutputSchema>;

// One flat view of everything the model may draw from. Composition
// slot data + score summary + evidence facts. The sandbox will not
// invent anything not represented here.
export interface OpportunityRationaleInput {
  candidate: {
    id: string;
    opportunityQuality: number;
    confidenceScore: number;
    founderFitScore: number;
    ventureScore: number;
    founderFitRationale: string | null;
  };
  composition: {
    role: keyof typeof COMPOSITION_FIELD_WHITELIST;
    node: Record<string, unknown>;
  }[];
  // Evidence rows that back any slot of the candidate — as (id, extractedFact)
  // pairs. Only these ids are valid source_ref targets under the "evidence:" prefix.
  evidence: { id: string; sourceType: string; extractedFact: string; polarity: "supporting" | "contradicting" }[];
  // Signals the risk_summary is expected to consider explicitly — passing
  // these in makes the model's coverage of them mechanically checkable.
  signals: {
    contradictingEvidenceCount: number;
    nullCompositionFields: string[]; // "market.growth_rate_estimate" etc.
    founderFitGaps: string[]; // gaps text from the FounderFit rationale, split
  };
}

const SYSTEM_PROMPT = `You are the Opportunity Rationale Agent, running in a post-promotion phase of an opportunity-evaluation system. Your job is to phrase — NOT invent — the reasoning for one already-promoted Opportunity into two lists a human reader can scan quickly:

  rationale_bullets: 3 to 5 bullets. Each states ONE specific reason this opportunity is worth pursuing, grounded in a specific piece of the candidate's data.

  risk_summary: 2 to 4 bullets. Each names ONE concrete risk or gap already visible in the candidate's data (a contradicting evidence row, a null field, a founder-fit gap, a shaky score component). Not generic risk boilerplate ("market may change") — pointed, mechanism-specific risks the data itself surfaces.

THE ABSOLUTE RULE (mirrored from FounderFit): every bullet MUST carry a source_ref of one of these two shapes:

  "composition:<role>:<field>"
     where <role> is exactly one of: market, audience, problem, hypothesis, business_model
     and <field> is exactly one of that role's real DB columns (given to you in the input).
     Example: "composition:market:growth_rate_estimate"

  "evidence:<uuid>"
     where <uuid> is exactly the id of one of the evidence rows listed in the input.
     Example: "evidence:4916c993-4fba-4a03-9973-39e691fd0dc6"

If you cannot ground a bullet in a real field or a real evidence id from the input, DO NOT WRITE THAT BULLET. Prefer fewer, sharper, well-grounded bullets to a full set of vague ones. Do not invent competitor names, statistics, dates, mechanisms, or dynamics beyond what the input actually contains.

Phrasing preference: prefer precise, mechanism-grounded language over vague hedging. "Willingness-to-pay signal is 0.82 on a scale where 1.0 is definite prior payment" beats "there is some evidence customers might pay." If the underlying number is uncertain, name that uncertainty explicitly rather than softening the claim.

FIELD SEMANTICS you MUST respect when phrasing bullets that cite hypothesis fields:
  - validation_score: [0,1] the Confidence Agent's LLM-mediated, banded score of how well the hypothesis is answered by its cited evidence. High means the evidence directly addresses the mechanism.
  - supporting_evidence_strength: [0,1] a DETERMINISTIC tier-weighted score over the hypothesis's cited supporting evidence — high means many or high-authority sources back the hypothesis. DO NOT phrase this as "the model is confident" or "we are confident" — phrase it as evidence weight/authority (e.g. "backed by two industry-report-tier sources"). It is arithmetic over sources, not a judgment of correctness.
  - confidence (on hypothesis): [0,1] the model's OWN self-reported confidence in the hypothesis statement. Observability only; DO NOT treat it as external validation. If citing it, name it as a self-report ("the hypothesis extractor rated its own confidence at 0.8"), not as evidence of truth.

Rationale bullets should collectively cover: why the market/problem matters (demand side), why the mechanism works (hypothesis side), and why this candidate is better than alternatives (competitive/founder side). Risk summary bullets should collectively cover the specific gaps the input surfaces — do not miss the signals the input has named for you.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "rationale_bullets": [{"text": string, "source_ref": string}, ...],  // 3 to 5 entries
  "risk_summary":     [{"text": string, "source_ref": string}, ...]   // 2 to 4 entries
}`;

function buildUserPrompt(input: OpportunityRationaleInput): string {
  const roles = input.composition
    .map((c) => {
      const fieldList = COMPOSITION_FIELD_WHITELIST[c.role].join(", ");
      return `[${c.role}] valid fields: ${fieldList}\n  data: ${JSON.stringify(c.node)}`;
    })
    .join("\n\n");
  const evidence = input.evidence
    .map(
      (e) =>
        `  evidence:${e.id} [${e.sourceType}, ${e.polarity}] "${e.extractedFact.replace(/\s+/g, " ").slice(0, 220)}"`
    )
    .join("\n");
  return `[promoted candidate id="${input.candidate.id}"]
  venture_score: ${input.candidate.ventureScore}
  opportunity_quality: ${input.candidate.opportunityQuality}
  confidence_score: ${input.candidate.confidenceScore}
  founder_fit_score: ${input.candidate.founderFitScore}
  founder_fit_rationale: ${input.candidate.founderFitRationale ?? "(none written)"}

[composition slots — draw source_ref from these]
${roles}

[evidence — draw source_ref from these ids only]
${evidence || "(no cited evidence)"}

[signals the risk_summary should cover]
  contradicting_evidence_count: ${input.signals.contradictingEvidenceCount}
  null_composition_fields: ${JSON.stringify(input.signals.nullCompositionFields)}
  founder_fit_gaps: ${JSON.stringify(input.signals.founderFitGaps)}`;
}

export interface OpportunityRationaleSandboxResult {
  rawResponse: string;
  parsed: RationaleOutput | null;
  validationErrors: string[];
  groundingViolations: string[];
}

export async function runOpportunityRationaleSandbox(
  llm: LLMClient,
  input: OpportunityRationaleInput
): Promise<OpportunityRationaleSandboxResult> {
  const userPrompt = buildUserPrompt(input);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  const validationErrors: string[] = [];
  const groundingViolations: string[] = [];
  let parsed: RationaleOutput | null = null;

  try {
    const cleaned = rawResponse.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    const json = JSON.parse(cleaned);
    const result = RationaleOutputSchema.safeParse(json);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      parsed = result.data;
      const allowedEvidenceIds = new Set(input.evidence.map((e) => e.id));
      const validate = (b: { text: string; source_ref: string }, kind: string) => {
        const ref = b.source_ref.trim();
        if (ref.startsWith("composition:")) {
          const parts = ref.split(":");
          if (parts.length !== 3) {
            groundingViolations.push(`${kind}: source_ref "${ref}" malformed — expected composition:<role>:<field>`);
            return;
          }
          const [, role, field] = parts;
          const whitelist = COMPOSITION_FIELD_WHITELIST[role];
          if (!whitelist) {
            groundingViolations.push(`${kind}: source_ref "${ref}" — role "${role}" not a valid composition role`);
            return;
          }
          if (!whitelist.includes(field)) {
            groundingViolations.push(
              `${kind}: source_ref "${ref}" — field "${field}" is not one of the ${role}'s real DB columns (${whitelist.join(", ")})`
            );
            return;
          }
          // Also require that the input actually contained the specified role.
          const roleData = input.composition.find((c) => c.role === role);
          if (!roleData) {
            groundingViolations.push(
              `${kind}: source_ref "${ref}" — role "${role}" wasn't in the input's composition slots (input had: ${input.composition
                .map((c) => c.role)
                .join(", ")})`
            );
          }
        } else if (ref.startsWith("evidence:")) {
          const id = ref.slice("evidence:".length);
          if (!allowedEvidenceIds.has(id)) {
            groundingViolations.push(
              `${kind}: source_ref "${ref}" — evidence id "${id}" was not in the input's evidence list (invented citation)`
            );
          }
        } else {
          groundingViolations.push(
            `${kind}: source_ref "${ref}" — must start with either "composition:" or "evidence:"`
          );
        }
      };
      for (const b of parsed.rationale_bullets) validate(b, "rationale_bullets");
      for (const b of parsed.risk_summary) validate(b, "risk_summary");
    }
  } catch (err) {
    validationErrors.push(`JSON parse failed: ${(err as Error).message}`);
  }

  return { rawResponse, parsed, validationErrors, groundingViolations };
}
