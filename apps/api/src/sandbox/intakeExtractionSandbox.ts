// Intake Extraction Sandbox — per-turn structured extraction from a
// founder interview answer.
//
// Called once per interview turn (not batched at the end) so that
// contradiction detection can work against genuinely structured values
// as the interview progresses, not just raw text.
//
// GROUNDING DISCIPLINE: extraction pulls only what is explicitly stated
// in rawAnswer — no inference beyond what is written. The null path is
// the correct path for vague/off-topic answers. Same null-over-invented
// principle used throughout this project's extraction agents.
//
// OUTPUT SHAPES by field:
//   expertise          → string[] | null  (domain terms)
//   distributionAssets → string[] | null  (concrete named channels/assets)
//   capitalAvailability → string | null   (normalized label)
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import type { MustFillField } from "../intake/founderIntakeState";

// ──────────────────────────────────────────────────────────────────────
// Input
// ──────────────────────────────────────────────────────────────────────

export interface IntakeExtractionInput {
  field: MustFillField;
  question: string;
  rawAnswer: string;
}

// ──────────────────────────────────────────────────────────────────────
// Output schema — discriminated union on field
// ──────────────────────────────────────────────────────────────────────

// null = explicit "nothing extractable" signal.
// For array fields:
//   []   = founder explicitly stated they have none (e.g. "I have no channels")
//   null = answer was too vague/off-topic to extract anything

const ExpertiseOutputSchema = z.object({
  field: z.literal("expertise"),
  extracted: z.array(z.string()).nullable(),
});

const DistributionAssetsOutputSchema = z.object({
  field: z.literal("distributionAssets"),
  extracted: z.array(z.string()).nullable(),
});

const CapitalAvailabilityOutputSchema = z.object({
  field: z.literal("capitalAvailability"),
  extracted: z.string().nullable(),
});

export const IntakeExtractionOutputSchema = z.discriminatedUnion("field", [
  ExpertiseOutputSchema,
  DistributionAssetsOutputSchema,
  CapitalAvailabilityOutputSchema,
]);

export type IntakeExtractionOutput = z.infer<typeof IntakeExtractionOutputSchema>;

// ──────────────────────────────────────────────────────────────────────
// Prompts
// ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a strict grounded-extraction utility for a founder interview system.

Given ONE interview question and the founder's raw answer, extract a structured value for the specified target field.

GROUNDING RULES — follow them exactly:
- Only extract values that are EXPLICITLY STATED in the raw answer. No inference from general knowledge, industry stereotypes, or implications.
- If the raw answer is too vague, off-topic, or doesn't actually state anything extractable for the target field, return null for "extracted". Never fabricate or guess.
- For array fields: return [] (empty array) ONLY if the founder explicitly says they have none (e.g. "I have no email list"). Return null if they simply gave a vague or off-topic answer.

FIELD-SPECIFIC RULES:

expertise: Extract domain/industry terms and role descriptions from the founder's professional background. Each item should be a concise term like "e-commerce marketing", "Shopify app development", "B2B SaaS sales", "subscription billing platforms". Single vague words with no domain context (e.g. just "software", "tech", "business") are not extractable — return null.

distributionAssets: Extract concrete, named channels or assets the founder can use to reach customers. Each item should name the channel and, if stated, its scale: "Newsletter with 8k e-commerce subscribers", "Shopify App Store listing", "LinkedIn network of 3k DTC merchants". Generic claims like "I know people" or "I have a network" without naming the channel are not extractable — return null.

capitalAvailability: Normalize the founder's capital situation into one of these labels:
- "bootstrapped" — self-funded / no outside money / personal savings
- "pre-revenue, self-funded" — no revenue yet and self-funded explicitly
- "$X raised" — specific amount raised (e.g. "$200K raised", "$1.2M raised")
- "revenue-funded" — business funds itself via its own revenue
- "undisclosed external funding" — external investors mentioned but no amount
- "figuring it out" — capital situation not yet determined
If the answer does not state the capital situation, return null.

Respond with ONLY valid JSON — no preamble, no explanation, no markdown fences. The JSON must match one of these shapes depending on the target field:

For expertise:
{ "field": "expertise", "extracted": string[] | null }

For distributionAssets:
{ "field": "distributionAssets", "extracted": string[] | null }

For capitalAvailability:
{ "field": "capitalAvailability", "extracted": string | null }`;

function buildUserPrompt(input: IntakeExtractionInput): string {
  return `Target field: ${input.field}

Question asked: ${input.question}

Founder's raw answer: ${input.rawAnswer}`;
}

// ──────────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────────

export interface IntakeExtractionSandboxResult {
  rawResponse: string;
  parsed: IntakeExtractionOutput | null;
  validationErrors: string[];
}

// ──────────────────────────────────────────────────────────────────────
// Sandbox runner
// ──────────────────────────────────────────────────────────────────────

export async function runIntakeExtractionSandbox(
  llm: LLMClient,
  input: IntakeExtractionInput
): Promise<IntakeExtractionSandboxResult> {
  const rawResponse = await llm.complete(SYSTEM_PROMPT, buildUserPrompt(input));

  const validationErrors: string[] = [];
  let parsed: IntakeExtractionOutput | null = null;

  try {
    const cleaned = rawResponse.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    const json = JSON.parse(cleaned);

    // Defense: model may omit the "field" discriminator key and just return
    // { "extracted": ... }. Inject it from input so Zod can parse the union.
    if (!("field" in json)) {
      json.field = input.field;
    }

    const result = IntakeExtractionOutputSchema.safeParse(json);
    if (!result.success) {
      validationErrors.push(result.error.toString());
    } else {
      // Filter empty strings out of array results — the model occasionally
      // emits [""] which would create phantom entries in the profile.
      const data = result.data;
      if (data.field !== "capitalAvailability" && Array.isArray(data.extracted)) {
        parsed = {
          ...data,
          extracted: (data.extracted as string[]).filter((s) => s.trim().length > 0),
        } as IntakeExtractionOutput;
      } else {
        parsed = data;
      }
    }
  } catch (err) {
    validationErrors.push(`JSON parse failed: ${(err as Error).message}`);
  }

  return { rawResponse, parsed, validationErrors };
}
