// FounderFit Sandbox — AI_AGENTS.md §9.
//
// GROUNDING UPGRADE (FounderEvidence layer):
// matched_strength claims are now evidence-id-grounded for founders who
// have gone through the Intake Engine. Each claimed matched_strength must
// cite a specific founder_evidence_id — the exact interview answer that
// supports it — rather than merely matching against an aggregated field
// value. This mirrors the main DAG's citation discipline (node_source_refs
// grounding hypothesis claims to real evidence sources).
//
// LEGACY / PRE-INTERVIEW-FLOW FOUNDERS (isLegacy: true):
// The one real founder row (fd88ecae) was manually inserted before the
// Intake Engine existed and has no founder_evidence rows. For these
// founders, FounderFit falls back to the original string-matching
// bounded-rule check against the aggregated field values. This is
// explicitly flagged in the prompt so the model knows the profile is
// ungrounded. A legacy founder's FounderFit output is still valid for
// pipeline purposes — it just can't cite a specific interview answer
// because there isn't one. When the founder completes an intake session,
// isLegacy becomes false and the full grounding discipline applies.
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import { parseLlmJson } from "./parseLlmJson";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

// A single founder_evidence row passed into the sandbox for grounding.
// targetField uses the same snake_case values as source_field so
// comparison is a direct string equality, no mapping needed.
export interface FounderEvidenceRecord {
  id: string;   // UUID — what the model must cite in founder_evidence_id
  targetField:
    | "expertise"
    | "distribution_assets"
    | "capital_availability"
    | "team_size"
    | "geography";
  extractedValue: string;
  rawAnswer: string;
}

export interface FounderFitProfile {
  id: string;
  expertise: string[];
  distributionAssets: string[];
  // Nullable scalars — null means "founder did not state a value".
  // Prompt renders "[not provided]" and the bounded-rule treats each
  // as an empty set (no matched_strength can be constructed from an
  // absent field). Do NOT substitute a placeholder string like
  // "unspecified" — that would pass the bounded-rule substring check
  // and defeat the grounding discipline. Same null-safety pattern is
  // applied uniformly across all three nullable scalars from the start.
  capitalAvailability: string | null;
  teamSize: number | null;
  geography: string | null;
  // Interview answer trail for citation. Empty → isLegacy must be true.
  founderEvidence: FounderEvidenceRecord[];
  // true  = founder was inserted before the Intake Engine existed.
  //         String-matching fallback; no evidence-id required.
  // false = founder completed (or is in-progress on) an intake session.
  //         Every matched_strength MUST cite a real founder_evidence_id.
  isLegacy: boolean;
}

export interface FounderFitOpportunitySummary {
  label: string;
  requirementsSummary: string;
}

export interface FounderFitSandboxInput {
  founder: FounderFitProfile;
  opportunity: FounderFitOpportunitySummary;
}

// ──────────────────────────────────────────────────────────────────────
// Output schema
// ──────────────────────────────────────────────────────────────────────

const MatchedStrengthSchema = z.object({
  source_field: z.enum([
    "expertise",
    "distribution_assets",
    "capital_availability",
    "team_size",
    "geography",
  ]),
  // Required for non-legacy profiles. UUID of the specific
  // founder_evidence row that grounds this strength claim.
  // Legacy profiles may omit or null this field.
  founder_evidence_id: z.string().uuid().nullable().optional(),
  matched_value: z.string().min(1),
  why_it_matters: z.string().min(10),
});

const FounderFitOutputSchema = z.object({
  founder_fit_score: z.number().min(0).max(100),
  matched_strengths: z.array(MatchedStrengthSchema),
  gaps: z.array(z.string()),
  rationale: z.string().min(20),
});

export type FounderFitOutput = z.infer<typeof FounderFitOutputSchema>;

// ──────────────────────────────────────────────────────────────────────
// System prompt
// ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `You are the FounderFit Agent in a larger opportunity-evaluation system.

Your job: given ONE founder's profile and an opportunity's requirements, judge how well-suited THIS SPECIFIC FOUNDER is to execute on it — not whether the opportunity itself is good. A great opportunity can be a poor fit for a founder who lacks what it requires; your score reflects fit, not opportunity quality.

FRAMING for the requirements summary you'll receive: any business-model or economics information in the requirements ("Competitive benchmark: ...", "operational complexity signal: ...", "capital intensity signal: ...", "margin profile: ...") describes the CLOSEST EXISTING COMPETITOR's model. It is the cost/margin/pricing/complexity structure the founder would be COMPETING AGAINST, not a plan the founder would run. Frame capital and complexity gaps in that light — say "the founder would need to compete against [competitor]'s [transaction-fee / capital-heavy / low-margin / etc.] model with only [their capital]" rather than implying the founder would run that model themselves.

The single most important rule: every "matched_strength" you claim MUST correspond to something that actually appears in the founder's profile — their real expertise entries, real distribution_assets entries, their stated capital_availability, their stated team_size, or their stated geography. Do NOT invent a capability, asset, headcount, or location the founder's profile doesn't actually list, even if it would make the fit story cleaner. If any of these fields is empty or [not provided], you cannot claim an advantage from it — that becomes a gap instead. In particular: team_size and geography being "[not provided]" means UNKNOWN, not "solo" and not any default region — treat unknown as a gap, do not guess.

Also identify gaps: what does this opportunity require that the founder's profile does NOT show they have? Be honest about these even when the overall fit is otherwise decent. When a gap is about capital or operational complexity, frame it as "would need to compete against [named competitor]'s [specific model attribute]" whenever the requirements name a specific competitor benchmark — that phrasing sharpens the reader's ability to judge the actual competitive dynamic.

Two founders with different profiles evaluated against the same opportunity should generally get different scores, different matched_strengths, and different gaps — if a founder's profile doesn't support a claim, don't make it just because it would apply to a different, more capable founder.`;

const SYSTEM_PROMPT_GROUNDED = `${SYSTEM_PROMPT_BASE}

EVIDENCE CITATION RULE (non-legacy profile):
This founder's profile is backed by specific interview answers. The [evidence_trail] section in the user message lists each answer with its id, field, and extracted value. For every matched_strength you claim, you MUST set "founder_evidence_id" to the id of the specific evidence entry that supports it. Do not invent an id; do not cite an id whose content doesn't directly support the claimed match. If no evidence entry supports a potential strength, it is a gap instead.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "founder_fit_score": number (0 to 100),
  "matched_strengths": [{ "source_field": "expertise" | "distribution_assets" | "capital_availability" | "team_size" | "geography", "founder_evidence_id": "<uuid from evidence_trail>", "matched_value": string, "why_it_matters": string }],
  "gaps": string[],
  "rationale": string
}`;

const SYSTEM_PROMPT_LEGACY = `${SYSTEM_PROMPT_BASE}

NOTE: This founder was created before the interview system existed (legacy profile). There is no evidence trail to cite. Omit "founder_evidence_id" from all matched_strengths.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "founder_fit_score": number (0 to 100),
  "matched_strengths": [{ "source_field": "expertise" | "distribution_assets" | "capital_availability" | "team_size" | "geography", "matched_value": string, "why_it_matters": string }],
  "gaps": string[],
  "rationale": string
}`;

// ──────────────────────────────────────────────────────────────────────
// User prompt builder
// ──────────────────────────────────────────────────────────────────────

function buildUserPrompt(input: FounderFitSandboxInput): string {
  const capitalLine =
    input.founder.capitalAvailability !== null
      ? `capital_availability: ${input.founder.capitalAvailability}`
      : `capital_availability: [not provided — treat as unknown, do NOT cite in matched_strengths]`;

  const teamSizeLine =
    input.founder.teamSize !== null
      ? `team_size: ${input.founder.teamSize}`
      : `team_size: [not provided — treat as unknown, do NOT cite in matched_strengths]`;

  const geographyLine =
    input.founder.geography !== null
      ? `geography: ${input.founder.geography}`
      : `geography: [not provided — treat as unknown, do NOT cite in matched_strengths]`;

  const profileSection = `[founder id="${input.founder.id}"]
expertise: ${JSON.stringify(input.founder.expertise)}
distribution_assets: ${JSON.stringify(input.founder.distributionAssets)}
${capitalLine}
${teamSizeLine}
${geographyLine}
[/founder]`;

  let evidenceSection = "";
  if (!input.founder.isLegacy && input.founder.founderEvidence.length > 0) {
    const lines = input.founder.founderEvidence
      .map(
        (e) =>
          `id: ${e.id}\nfield: ${e.targetField}\nextracted_value: ${JSON.stringify(e.extractedValue)}\nraw_answer: ${JSON.stringify(e.rawAnswer)}`
      )
      .join("\n---\n");
    evidenceSection = `\n\n[evidence_trail]\n${lines}\n[/evidence_trail]`;
  } else if (input.founder.isLegacy) {
    evidenceSection = `\n\n[evidence_trail]\n(legacy profile — no interview answers recorded)\n[/evidence_trail]`;
  }

  return `${profileSection}${evidenceSection}

[opportunity]
label: ${input.opportunity.label}
requirements: ${input.opportunity.requirementsSummary}
[/opportunity]`;
}

// ──────────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────────

export interface FounderFitSandboxResult {
  rawResponse: string;
  parsed: FounderFitOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Sandbox runner
// ──────────────────────────────────────────────────────────────────────

export async function runFounderFitSandbox(
  llm: LLMClient,
  input: FounderFitSandboxInput
): Promise<FounderFitSandboxResult> {
  const systemPrompt = input.founder.isLegacy ? SYSTEM_PROMPT_LEGACY : SYSTEM_PROMPT_GROUNDED;
  const userPrompt = buildUserPrompt(input);
  const rawResponse = await llm.complete(systemPrompt, userPrompt);

  let parsed: FounderFitOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];

  const parseResult = parseLlmJson(rawResponse);
  if (parseResult.error) {
    validationErrors.push(parseResult.error);
  } else {
    const result = FounderFitOutputSchema.safeParse(parseResult.data);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      parsed = result.data;

      if (input.founder.isLegacy) {
        // ── Legacy path: original string-matching fallback ──────────
        // Every nullable scalar → empty set when null, so the bidirectional
        // substring check below can never match against a placeholder.
        // teamSize is stringified because the check operates on text.
        const profileValuesByField: Record<string, string[]> = {
          expertise: input.founder.expertise,
          distribution_assets: input.founder.distributionAssets,
          capital_availability:
            input.founder.capitalAvailability !== null
              ? [input.founder.capitalAvailability]
              : [],
          team_size:
            input.founder.teamSize !== null ? [String(input.founder.teamSize)] : [],
          geography:
            input.founder.geography !== null ? [input.founder.geography] : [],
        };
        for (const m of parsed.matched_strengths) {
          const realValues = profileValuesByField[m.source_field] ?? [];
          const actuallyPresent = realValues.some(
            (v) =>
              v.toLowerCase().includes(m.matched_value.toLowerCase()) ||
              m.matched_value.toLowerCase().includes(v.toLowerCase())
          );
          if (!actuallyPresent) {
            boundedRuleViolations.push(
              `Claimed matched_strength "${m.matched_value}" (${m.source_field}) does not correspond to anything in this founder's actual profile (${JSON.stringify(realValues)}) — invented capability, not a real match`
            );
          }
        }
      } else {
        // ── Non-legacy path: evidence-id grounding ──────────────────
        const evidenceById = new Map(
          input.founder.founderEvidence.map((e) => [e.id, e])
        );

        for (const m of parsed.matched_strengths) {
          // 1. founder_evidence_id must be present
          if (!m.founder_evidence_id) {
            boundedRuleViolations.push(
              `matched_strength (${m.source_field}: "${m.matched_value}") is missing founder_evidence_id — non-legacy profiles must cite a specific interview answer`
            );
            continue;
          }

          // 2. cited id must exist in this founder's evidence trail
          const ev = evidenceById.get(m.founder_evidence_id);
          if (!ev) {
            boundedRuleViolations.push(
              `founder_evidence_id "${m.founder_evidence_id}" not found in this founder's evidence trail (${input.founder.founderEvidence.length} entries) — nonexistent or belongs to a different founder`
            );
            continue;
          }

          // 3. evidence's target_field must match source_field
          if (ev.targetField !== m.source_field) {
            boundedRuleViolations.push(
              `founder_evidence_id "${m.founder_evidence_id}" is for field "${ev.targetField}" but matched_strength claims source_field "${m.source_field}" — field mismatch`
            );
            continue;
          }

          // 4. matched_value must appear in the evidence's content
          //    (same bidirectional-substring discipline as the legacy check,
          //    but against the specific evidence record rather than the
          //    aggregated field value)
          const evidenceText = `${ev.extractedValue} ${ev.rawAnswer}`.toLowerCase();
          const mv = m.matched_value.toLowerCase();
          const contentGrounded =
            evidenceText.includes(mv) ||
            mv.includes(ev.extractedValue.toLowerCase());
          if (!contentGrounded) {
            boundedRuleViolations.push(
              `Claimed matched_value "${m.matched_value}" does not appear in the cited evidence (id=${m.founder_evidence_id}, field=${ev.targetField}, extracted="${ev.extractedValue}") — invented claim not supported by the cited answer`
            );
          }
        }
      }
    }
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations };
}
