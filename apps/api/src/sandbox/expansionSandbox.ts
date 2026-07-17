// Expansion Sandbox — the actual acid test of the project's central
// bet (symptom ≠ cause), not Discovery. Discovery only ever produces
// Market from demand/industry-report signals; Expansion is the agent
// that turns review/complaint text into Problem nodes, and
// AI_AGENTS.md §2's real invariant is the one worth stress-testing:
// "severity_signal and frequency_signal MUST derive from an
// observable proxy in source text — MUST NOT be set from agent
// judgment."
//
// This sandbox operationalizes that invariant mechanically, not just
// in prose: whenever a Problem carries a severity_signal or
// frequency_signal, the model must also supply a short quote from the
// source text as justification, and the harness verifies that quote
// is an actual substring of the cited document — not merely plausible-
// sounding. This closes the exact kind of gap discoverySandbox.ts left
// open (it could catch a hallucinated *citation* but not a fabricated
// *number* with no textual grounding at all).
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import { parseLlmJson } from "./parseLlmJson";

export interface ExpansionInputDocument {
  id: string;
  sourceType: "review_complaint";
  text: string;
}

const ProblemCandidateSchema = z
  .object({
    label: z.string().min(1),
    problem_maturity: z.enum(["unrecognized", "recognized_unsolved", "partially_solved"]),
    current_workaround_description: z.string().nullable(),
    severity_signal: z.number().min(0).max(1).nullable(),
    severity_evidence_quote: z.string().nullable(),
    frequency_signal: z.number().min(0).max(1).nullable(),
    frequency_evidence_quote: z.string().nullable(),
    evidence_refs: z.array(z.string()).min(1),
    // Labels of audiences (from the same response's `audiences[]` array)
    // that experience this problem. Optional at the SCHEMA level so
    // legacy fixtures and jsonrepair recoveries of pre-existing NIM
    // responses still validate; but required in effect via a fallback
    // in expansionAgent.ts (see the header note about the Composition
    // experiences-edge gap this closes). When the model omits or leaves
    // the field empty, the agent falls back to linking the problem to
    // EVERY audience emitted for the same market — this is a
    // conservative safe default (the market's audiences are all the
    // ones the model considered, so all-experience the problem within
    // that market) that guarantees Composition's 5-role invariant is
    // satisfiable. When the field IS present, hallucinated labels
    // (labels that don't match any emitted audience) are caught as
    // Bounded Rule violations by runExpansionSandbox below — the
    // sandbox's normal fail-loud-on-hallucination discipline.
    experiencing_audience_labels: z.array(z.string().min(1)).optional(),
  })
  .refine((p) => p.severity_signal === null || p.severity_evidence_quote !== null, {
    message: "severity_signal set without severity_evidence_quote — violates the observable-proxy invariant",
  })
  .refine((p) => p.frequency_signal === null || p.frequency_evidence_quote !== null, {
    message: "frequency_signal set without frequency_evidence_quote — violates the observable-proxy invariant",
  });

const AudienceCandidateSchema = z.object({
  label: z.string().min(1),
  description: z.string().nullable(),
  evidence_refs: z.array(z.string()).min(1),
});

const ExpansionOutputSchema = z.object({
  audiences: z.array(AudienceCandidateSchema),
  problems: z.array(ProblemCandidateSchema),
});

export type ExpansionOutput = z.infer<typeof ExpansionOutputSchema>;

function buildSystemPrompt(marketLabel: string): string {
  return `You are the Expansion Agent in a larger opportunity-evaluation system.

Your job: extract candidate Audience and Problem nodes from the provided review/complaint documents, for an already-established Market ("${marketLabel}").

Every problem you emit must move through three steps: SYMPTOM (what users/customers complain about) → MECHANISM (the platform behavior or policy that produces it, per the text) → GAP (the capability, distinction, or tooling that is missing as a result). The GAP is the Problem. Symptom and mechanism are context; they are not the label.

Worked example, from the shape of source text this agent typically sees:
- Symptom: "customers keep cancelling."
- Mechanism: "removing a saved card silently cancels every active subscription tied to it."
- GAP (this is the label): "No way for merchants to distinguish a customer who intended to cancel from one whose subscription was auto-cancelled by a card change" — because that distinction is what merchants need to route the two failure modes to different retention actions, and nothing in the platform currently gives it to them.

Notice the label above does NOT name the mechanism ("automatic cancellation on card removal"). It names what the affected users CAN'T DO that they need to do. That is the required shape.

BEFORE you write each Problem label, apply this one-line test to it: does the label name a capability that is currently missing, or does it name a thing that the platform does? If it names a thing the platform does, rewrite it to name the missing capability instead — even if the mechanism is technically accurate, a mechanism-only label is a partial answer, not a complete one, and will be treated as a failure of this extraction step.

Rules you MUST follow exactly:
- The Problem "label" field MUST be phrased as a missing capability, distinction, or tooling — typically starting with "No way to...", "Users cannot...", "Missing ability to...", or an equivalent gap-framed noun phrase. A label that is only a mechanism, symptom, or platform behavior name is not acceptable and must be rewritten before you emit it.
- Read ONLY the provided documents. No outside knowledge about ${marketLabel} features not stated in the text.
- Every audience/problem MUST cite at least one input document id in evidence_refs.
- If you assign a severity_signal or frequency_signal (0 to 1) to a problem, you MUST also provide the exact short quote (a few words, verbatim from the source text) that justifies it, in severity_evidence_quote / frequency_evidence_quote. If the text does not state anything about how severe or how frequent the problem is, leave both signal and quote as null — do NOT estimate from general impression.
- For every problem you emit, populate "experiencing_audience_labels" with the exact label strings (from your own audiences[] array) of the audiences that experience this problem. This is the audience↔problem linkage the downstream Composition step needs to assemble a scorable opportunity — a problem with no audiences declared cannot be scored. If a single audience experiences every problem in the market (common for narrow verticals), list that one label on every problem.
- Do not rank or recommend solutions. Structure only.
- The "problem_maturity" field MUST be exactly one of these three literal strings, copied verbatim including underscores: "unrecognized", "recognized_unsolved", "partially_solved". Do NOT abbreviate (e.g. do not write "recognized" as a shorthand for "recognized_unsolved"), do not paraphrase, do not translate — the downstream schema rejects anything else.

Respond with ONLY valid JSON matching this exact shape, no other text:
{
  "audiences": [{ "label": string, "description": string | null, "evidence_refs": string[] }],
  "problems": [{
    "label": string,
    "problem_maturity": "unrecognized" | "recognized_unsolved" | "partially_solved",
    "current_workaround_description": string | null,
    "severity_signal": number | null,
    "severity_evidence_quote": string | null,
    "frequency_signal": number | null,
    "frequency_evidence_quote": string | null,
    "evidence_refs": string[],
    "experiencing_audience_labels": string[]
  }]
}`;
}

// Appended on retry after a parse failure — emphasises output discipline
// without altering the extraction rules themselves.
const RETRY_SUFFIX =
  "\n\nCRITICAL CORRECTION: Your previous response could not be parsed as valid JSON. " +
  "This is your final attempt. Respond with ONLY the JSON object — no prose, no markdown " +
  "fences, and never embed literal newline or control characters inside string values " +
  "(escape them as \\n if needed).";

// Observed in prod (run f17f7c6d…): the model repeatedly serialised
// "recognized" as a natural-language shortening of the schema value
// "recognized_unsolved" — same input yielded "recognized" twice, then
// "recognized_unsolved" on retry. Map the known aliases (case- and
// whitespace-insensitive) rather than failing the whole response. Genuine
// unknown values still fall through to schema rejection.
const PROBLEM_MATURITY_ALIASES: Record<string, "unrecognized" | "recognized_unsolved" | "partially_solved"> = {
  recognized: "recognized_unsolved",
  unsolved: "recognized_unsolved",
  recognized_but_unsolved: "recognized_unsolved",
  "partially solved": "partially_solved",
  partial: "partially_solved",
  unknown: "unrecognized",
  unacknowledged: "unrecognized",
};

function canonicalizeProblemMaturity(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "unrecognized" || normalized === "recognized_unsolved" || normalized === "partially_solved") {
    return normalized;
  }
  return PROBLEM_MATURITY_ALIASES[normalized] ?? PROBLEM_MATURITY_ALIASES[value.trim().toLowerCase()] ?? value;
}

// Pre-validation normalization: enforce observable-proxy invariant by stripping
// any signal field whose matching quote field is absent, rather than letting
// schema validation reject the entire response. This is more reliable than
// asking the LLM to self-correct on retry — LLMs consistently set numeric
// signals based on semantic inference from the source text but don't always
// copy the exact verbatim phrase as required. Stripping the signal preserves
// the problem (with null signals) rather than discarding the entire response.
// Also canonicalises problem_maturity synonyms (see canonicalizeProblemMaturity).
function normalizeSignals(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.problems)) return raw;
  return {
    ...obj,
    problems: (obj.problems as Record<string, unknown>[]).map((p) => ({
      ...p,
      problem_maturity: canonicalizeProblemMaturity(p.problem_maturity),
      severity_signal: p.severity_evidence_quote != null ? p.severity_signal : null,
      frequency_signal: p.frequency_evidence_quote != null ? p.frequency_signal : null,
    })),
  };
}

function buildUserPrompt(documents: ExpansionInputDocument[]): string {
  const docBlocks = documents
    .map((d) => `[document id="${d.id}" source_type="${d.sourceType}"]\n${d.text}\n[/document]`)
    .join("\n\n");
  return `Here are the documents:\n\n${docBlocks}`;
}

// Try to produce a parsed JS value from a raw model response. Delegates
// to the shared parseLlmJson helper so every LLM-facing sandbox uses
// the same recovery path (native JSON.parse → jsonrepair fallback).
// Returns null when both native parse AND jsonrepair fail — kept as
// null-not-error for compat with the existing Expansion retry logic
// below that already branches on this.
function tryParse(raw: string): { data: unknown; repaired: boolean } | null {
  const result = parseLlmJson(raw);
  if (result.error) return null;
  return { data: result.data, repaired: result.repaired };
}

export interface ExpansionSandboxResult {
  rawResponse: string;
  parsed: ExpansionOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[];
  /** true if jsonrepair was needed to recover well-formed JSON */
  repaired: boolean;
  /** true if a second LLM call was made due to initial parse failure */
  retried: boolean;
  /** Per-field count of signal+quote pairs stripped because the quote was not
   *  found verbatim in any cited document. Zero on the happy path. */
  fabricationStrips: { severity: number; frequency: number };
}

export async function runExpansionSandbox(
  llm: LLMClient,
  documents: ExpansionInputDocument[],
  marketLabel: string
): Promise<ExpansionSandboxResult> {
  const systemPrompt = buildSystemPrompt(marketLabel);
  const userPrompt = buildUserPrompt(documents);

  // First attempt
  const firstRaw = await llm.complete(systemPrompt, userPrompt);
  let parseResult = tryParse(firstRaw);
  let rawResponse = firstRaw;
  let retried = false;

  // Retry 1 — JSON parse failure: retry once with a stricter JSON-output
  // instruction before giving up. This handles models that produce syntactically
  // valid output on the retry even when they can't always do it on the first pass.
  if (parseResult === null) {
    retried = true;
    const retryRaw = await llm.complete(systemPrompt + RETRY_SUFFIX, userPrompt);
    rawResponse = retryRaw;
    parseResult = tryParse(retryRaw);
  }

  const repaired = parseResult?.repaired ?? false;

  let parsed: ExpansionOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];
  const fabricationStrips = { severity: 0, frequency: 0 };

  if (parseResult === null) {
    validationErrors.push(
      retried
        ? "JSON parse failed after jsonrepair attempt and retry: unable to recover valid JSON from either response"
        : "JSON parse failed: jsonrepair could not recover valid JSON"
    );
  } else {
    try {
      // Apply normalization before schema validation: strip any signal field
      // whose companion quote field is absent. The refine() invariant is thus
      // satisfied by construction rather than rejected and retried.
      const normalized = normalizeSignals(parseResult.data);
      const schemaResult = ExpansionOutputSchema.safeParse(normalized);

      if (!schemaResult.success) {
        validationErrors.push(schemaResult.error.toString());
      } else {
        // Build mutable problem copies so the grounding check can strip
        // fabricated signal/quote pairs without recording them as BRVs —
        // stripping is more conservative (null signal) than rejecting the whole
        // response, and more honest than keeping a wrong numeric value.
        const problems: ExpansionOutput["problems"] = schemaResult.data.problems.map((p) => ({ ...p }));
        parsed = { audiences: schemaResult.data.audiences, problems };
        const docsById = new Map(documents.map((d) => [d.id, d.text]));

        const checkRefs = (label: string, refs: string[]) => {
          const bad = refs.filter((r) => !docsById.has(r));
          if (bad.length > 0) {
            boundedRuleViolations.push(`"${label}" cites nonexistent evidence_refs: ${bad.join(", ")}`);
          }
        };
        const normalizeStr = (s: string) => s.replace(/\s+/g, " ").trim();
        // Grounding check: if a signal quote is not a verbatim substring of any
        // cited document, strip the signal+quote pair silently. Recording it as a
        // BRV would throw and retry — but LLMs that paraphrase rather than
        // verbatim-copy will never recover on retry, so stripping is better.
        const stripIfUngrounded = (
          p: (typeof problems)[number],
          quote: string | null,
          field: "severity" | "frequency"
        ) => {
          if (!quote) return;
          const normalizedQuote = normalizeStr(quote);
          const groundedInAny = p.evidence_refs.some((r) => {
            const docText = docsById.get(r);
            return docText ? normalizeStr(docText).includes(normalizedQuote) : false;
          });
          if (!groundedInAny) {
            fabricationStrips[field]++;
            console.warn(
              `[expansionSandbox] fabricated_grounding_stripped field=${field} problem="${p.label}"`
            );
            if (field === "severity") {
              p.severity_signal = null;
              p.severity_evidence_quote = null;
            } else {
              p.frequency_signal = null;
              p.frequency_evidence_quote = null;
            }
          }
        };

        for (const a of parsed.audiences) checkRefs(a.label, a.evidence_refs);
        // Any experiencing_audience_labels the model DID supply must
        // resolve to a real audience label emitted in this same response.
        // A label that doesn't match is a hallucinated cross-reference —
        // treat it the same way we treat hallucinated evidence_refs
        // (fail loud, no partial output). The agent's Cartesian
        // fallback for absent labels is a separate concern from the
        // present-but-invalid case handled here.
        const audienceLabels = new Set(parsed.audiences.map((a) => a.label));
        for (const p of problems) {
          checkRefs(p.label, p.evidence_refs);
          stripIfUngrounded(p, p.severity_evidence_quote, "severity");
          stripIfUngrounded(p, p.frequency_evidence_quote, "frequency");
          if (p.experiencing_audience_labels && p.experiencing_audience_labels.length > 0) {
            const bad = p.experiencing_audience_labels.filter((l) => !audienceLabels.has(l));
            if (bad.length > 0) {
              boundedRuleViolations.push(
                `problem "${p.label}" cites experiencing_audience_labels not present in the audiences[] array: ${bad.join(", ")} — hallucinated audience cross-reference`
              );
            }
          }
        }
      }
    } catch (err) {
      validationErrors.push(`Validation threw unexpectedly: ${(err as Error).message}`);
    }
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations, repaired, retried, fabricationStrips };
}
