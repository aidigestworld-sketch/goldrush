// CompetitiveAnalysis Sandbox — the trap here is different from
// Discovery's (hallucinated numbers) and Expansion's (fabricated
// severity/frequency grounding): AI_AGENTS.md §4's real risk is
// inferring from CATEGORY STEREOTYPES ("it's a SaaS subscription tool,
// it probably has a free trial") rather than extracting only what a
// competitor's own material actually states. The invariant is:
// "a positioning attribute not stated by the competitor is stored as
// NULL with lowered confidence — MUST NOT be inferred or back-filled."
//
// Mechanically enforced the same way as Expansion's grounding check:
// positioning_summary, pricing_summary, and business_model.model_type
// each require an accompanying quote, verified as an actual substring
// of the cited competitor's document (whitespace-normalized, same
// fix as expansionSandbox.ts).
//
// A second, distinct thing this sandbox checks: whether the model can
// tell the difference between a competitor's own stated position and
// a third party's opinion ABOUT that competitor (doc-303's analyst
// commentary) — conflating the two is a source-authority error, not
// just a grounding error, and worth surfacing even though it's a
// softer, non-mechanical check here (full authority-tier weighting is
// Confidence Agent's job downstream, not CompetitiveAnalysis's).
// FINDING FROM TESTING (not a code bug — a fixture/architecture
// insight): this sandbox's mock test caught a case where the model
// correctly extracted a quote ("reliable but less innovative") but
// mislabeled its source as competitor-stated when it was actually
// third-party analyst commentary. The grounding check (substring
// match) couldn't catch this, because the quote genuinely IS in the
// document — the error is attribution, not fabrication.
//
// The real fix isn't more sandbox logic — it's upstream: this fixture
// bundled a competitor's own material and a third party's commentary
// about that competitor into ONE document, which isn't how real
// ingestion should work. Every Evidence row already carries its own
// source_authority_tier from Data Pipeline (GRAPH_SCHEMA.md §2.1) —
// analyst commentary about a competitor should be ingested as its own
// Evidence row (source_type='industry_report'), separate from that
// competitor's own material (source_type='competitor_material'), from
// the moment Data Pipeline ingests it. Done that way, this ambiguity
// is structurally impossible by the time CompetitiveAnalysis Agent
// ever sees the data — worth keeping in mind when Phase 2's connectors
// expand to cover analyst/comparison content, not something to solve
// with a smarter prompt here.
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import { parseLlmJson } from "./parseLlmJson";

export interface CompetitiveAnalysisInputDocument {
  id: string;
  competitorName: string;
  sourceType: "competitor_material";
  text: string;
}

const ExistingSolutionCandidateSchema = z
  .object({
    label: z.string().min(1),
    positioning_summary: z.string().nullable(),
    positioning_summary_quote: z.string().nullable(),
    positioning_summary_is_competitor_stated: z.boolean(),
    pricing_summary: z.string().nullable(),
    pricing_summary_quote: z.string().nullable(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    estimated_market_share: z.number().nullable(),
    evidence_refs: z.array(z.string()).min(1),
  })
  .refine((s) => s.positioning_summary === null || s.positioning_summary_quote !== null, {
    message: "positioning_summary set without a grounding quote",
  })
  .refine((s) => s.pricing_summary === null || s.pricing_summary_quote !== null, {
    message: "pricing_summary set without a grounding quote",
  });

const BusinessModelCandidateSchema = z
  .object({
    competitor_label: z.string().min(1),
    model_type: z.string().min(1),
    model_type_quote: z.string().min(1), // always required — this is the field most prone to category-stereotype inference
    evidence_refs: z.array(z.string()).min(1),
  });

const CompetitiveAnalysisOutputSchema = z.object({
  existing_solutions: z.array(ExistingSolutionCandidateSchema),
  business_models: z.array(BusinessModelCandidateSchema),
});

export type CompetitiveAnalysisOutput = z.infer<typeof CompetitiveAnalysisOutputSchema>;

const SYSTEM_PROMPT = `You are the CompetitiveAnalysis Agent in a larger opportunity-evaluation system.

Your job: extract candidate ExistingSolution and BusinessModel nodes from the provided competitor material — one document per named competitor.

The single most important rule: extract ONLY what the text actually states about each competitor. Do NOT fill in plausible-sounding details from general knowledge of what similar tools "usually" have (pricing tiers, free trials, feature sets). If the text doesn't say it, the field is null — never a guess, even an educated one.

For every non-null positioning_summary or pricing_summary, you MUST provide the exact short quote (a few words, verbatim from the source text) that justifies it.

"Verbatim" means copied character-for-character from the source — not reworded, not reordered, not combined from two different parts of a sentence, not re-punctuated. A live test run showed a smaller model doing exactly the wrong thing here: given source text "a free tier scaling up to $399/month, with a 0.75-1.0% transaction fee", it returned the quote "Free tier scaling up to $399/month" — dropping the article and capitalizing the first letter. That is a paraphrase, not a quote, even though it's short and accurate, and it will be rejected. Correct behavior: copy a contiguous span exactly as it appears, including articles, capitalization, and punctuation — "a free tier scaling up to $399/month" is a valid quote from that source; "Free tier scaling up to $399/month" is not.

business_models is different from existing_solutions: model_type and model_type_quote can NEVER be null — the underlying record cannot exist without a named category. If a competitor's text describes pricing figures (dollar amounts, percentages, fees) but never names or clearly implies a monetization CATEGORY (e.g. "flat fee", "tiered", "freemium", "usage-based", "hybrid percent-plus-per-order"), do NOT invent one and do NOT include a null-valued row for that competitor — OMIT that competitor from business_models entirely. A stated dollar figure is not automatically a named category; only include a business_models entry when you can quote text that actually names or unambiguously implies the category itself, not just numbers.

Also distinguish: is a claim about a competitor coming from the competitor's OWN material, or from a third party's commentary about them? Set positioning_summary_is_competitor_stated to false if the quote is analyst/third-party opinion rather than the competitor's own words — do not present a third party's characterization as if it were the competitor's self-description.

evidence_refs format — MUST be the bare document id ONLY: exactly the UUID string that appears inside id="..." on each [document ...] tag. Do NOT prefix with "document ", "doc ", "id:", or any other wrapper; do NOT wrap in brackets or quotes-within-strings; do NOT re-emit the whole [document ...] tag. Only the raw UUID.
Correct:   "evidence_refs": ["3877e3f3-fcd9-43df-9f40-1bc69b7e42ec"]
Incorrect: "evidence_refs": ["document 3877e3f3-fcd9-43df-9f40-1bc69b7e42ec"]
Incorrect: "evidence_refs": ["[document id=\"3877e3f3-...\"]"]

Do not rank competitors or recommend anything. Structure only.

Respond with ONLY valid JSON matching this exact shape. Your response MUST begin with { and end with }. Do not include any explanation, preamble, commentary, or markdown formatting before or after the JSON object — not even a single word:
{
  "existing_solutions": [{
    "label": string,
    "positioning_summary": string | null,
    "positioning_summary_quote": string | null,
    "positioning_summary_is_competitor_stated": boolean,
    "pricing_summary": string | null,
    "pricing_summary_quote": string | null,
    "strengths": string[],
    "weaknesses": string[],
    "estimated_market_share": number | null,
    "evidence_refs": string[]  // bare document ids from the input (no "document " prefix), non-empty
  }],
  "business_models": [{
    // ONLY include an entry here if a real category can be named from
    // the text (see rule above) — omit the competitor entirely otherwise,
    // never submit this object with null fields
    "competitor_label": string,
    "model_type": string,
    "model_type_quote": string,
    "evidence_refs": string[]  // bare document ids from the input (no "document " prefix), non-empty
  }]
}`;

function buildUserPrompt(documents: CompetitiveAnalysisInputDocument[]): string {
  const docBlocks = documents
    .map((d) => `[document id="${d.id}" competitor="${d.competitorName}"]\n${d.text}\n[/document]`)
    .join("\n\n");
  return `Here are the documents:\n\n${docBlocks}`;
}

export interface CompetitiveAnalysisSandboxResult {
  rawResponse: string;
  parsed: CompetitiveAnalysisOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[];
  sourceAttributionWarnings: string[]; // softer than boundedRuleViolations — flags competitor-vs-third-party confusion
}

function normalize(s: string): string {
  // Case-insensitive on top of whitespace-normalized: found via a live
  // run where a 9B model correctly extracted every fact but
  // capitalized the first letter of a quote when starting a sentence
  // with it (e.g. "Free tier..." vs the source's "a free tier...") —
  // that's trivial reformatting, not fabrication, and shouldn't fail
  // the same check that's supposed to catch invented facts. Real
  // paraphrasing/reordering beyond case still fails, correctly.
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function runCompetitiveAnalysisSandbox(
  llm: LLMClient,
  documents: CompetitiveAnalysisInputDocument[]
): Promise<CompetitiveAnalysisSandboxResult> {
  const userPrompt = buildUserPrompt(documents);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  let parsed: CompetitiveAnalysisOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];
  const sourceAttributionWarnings: string[] = [];

  const parseResult = parseLlmJson(rawResponse);
  if (parseResult.error) {
    validationErrors.push(parseResult.error);
  } else {
    const result = CompetitiveAnalysisOutputSchema.safeParse(parseResult.data);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      parsed = result.data;
      const docsById = new Map(documents.map((d) => [d.id, d.text]));

      // Defensive normalization for a class of LLM output where the
      // prompt's `[document id="<uuid>"]` wrapper leaks into the
      // response as `"document <uuid>"`. Prompt has been tightened to
      // instruct bare ids only (see SYSTEM_PROMPT above), but a mid-tier
      // model occasionally still echoes the wrapper — strip a leading
      // "document " (case-insensitive, whitespace-tolerant). Any other
      // malformed form (e.g. wrong UUID) still fails the has() check.
      //
      // Applied in-place on `parsed` so downstream (agent write-path in
      // competitiveAnalysisAgent.ts:145, 164) receives already-clean ids
      // — otherwise a "document <uuid>" would slip through validation
      // here and then FK-fail at nodeSourceRefRepository.createMany.
      const normalizeRef = (r: string): string => r.trim().replace(/^document\s+/i, "");
      for (const s of parsed.existing_solutions) {
        s.evidence_refs = s.evidence_refs.map(normalizeRef);
      }
      for (const bm of parsed.business_models) {
        bm.evidence_refs = bm.evidence_refs.map(normalizeRef);
      }

      const checkRefs = (label: string, refs: string[]) => {
        const bad = refs.filter((r) => !docsById.has(r));
        if (bad.length > 0) boundedRuleViolations.push(`"${label}" cites nonexistent evidence_refs: ${bad.join(", ")}`);
      };
      const isGrounded = (quote: string, refs: string[]): boolean => {
        const normalizedQuote = normalize(quote);
        return refs.some((r) => docsById.get(r) && normalize(docsById.get(r)!).includes(normalizedQuote));
      };

      // Strip-and-continue for positioning_summary / pricing_summary — both
      // are OPTIONAL fields (schema allows null summary + null quote).
      // Mirrors expansionSandbox.ts:270-291's stripIfUngrounded rationale:
      // "LLMs that paraphrase rather than verbatim-copy will never recover
      // on retry, so stripping is better." Live-verified against
      // nvidia-nemotron-nano-9b-v2 on 2026-07-20: model consistently
      // paraphrases pricing quotes ("Plans run from $10/mo..." vs source's
      // "Starter | $10 USD | 50 | 3" table format) — retrying just wastes
      // NIM calls. We keep the solution row (label + strengths + weaknesses
      // still land), just null the fields that couldn't be verbatim-grounded.
      //
      // Preserves grounding discipline: an ungrounded quote never lands in
      // the DB as if it were extraction. It becomes null with a warning
      // logged for observability, same treatment Expansion applies.
      const stripUngroundedSummary = (
        label: string,
        s: { positioning_summary: string | null; positioning_summary_quote: string | null; pricing_summary: string | null; pricing_summary_quote: string | null },
        refs: string[]
      ) => {
        if (s.positioning_summary_quote && !isGrounded(s.positioning_summary_quote, refs)) {
          console.warn(`[competitiveAnalysisSandbox] fabricated_grounding_stripped field=positioning_summary solution="${label}"`);
          s.positioning_summary = null;
          s.positioning_summary_quote = null;
        }
        if (s.pricing_summary_quote && !isGrounded(s.pricing_summary_quote, refs)) {
          console.warn(`[competitiveAnalysisSandbox] fabricated_grounding_stripped field=pricing_summary solution="${label}"`);
          s.pricing_summary = null;
          s.pricing_summary_quote = null;
        }
      };

      for (const s of parsed.existing_solutions) {
        checkRefs(s.label, s.evidence_refs);
        stripUngroundedSummary(s.label, s, s.evidence_refs);
        if (s.positioning_summary !== null && !s.positioning_summary_is_competitor_stated) {
          sourceAttributionWarnings.push(
            `"${s.label}": positioning_summary is flagged as third-party commentary, not competitor-stated — confirm this isn't being presented as the competitor's own position downstream`
          );
        }
      }

      // business_models: model_type_quote is REQUIRED by the schema (line 79
      // comment: "the field most prone to category-stereotype inference"),
      // so we can't null it like the summary fields. Instead, DROP the
      // whole business_model entry when its quote doesn't ground — same
      // spirit as Expansion's stripping (don't let ungrounded content into
      // the DB, but don't block the whole run either). Nonexistent-ref BRVs
      // still fire loud (that's real hallucination, not paraphrasing).
      const droppedBmLabels: string[] = [];
      parsed.business_models = parsed.business_models.filter((bm) => {
        checkRefs(bm.competitor_label, bm.evidence_refs);
        if (!isGrounded(bm.model_type_quote, bm.evidence_refs)) {
          droppedBmLabels.push(bm.competitor_label);
          return false;
        }
        return true;
      });
      if (droppedBmLabels.length > 0) {
        console.warn(
          `[competitiveAnalysisSandbox] fabricated_grounding_stripped field=model_type_quote dropped_business_models=[${droppedBmLabels.join(", ")}]`
        );
      }
    }
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations, sourceAttributionWarnings };
}
