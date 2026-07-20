// Discovery Sandbox — raw documents -> Discovery Agent -> validated
// JSON. No DAG, no Orchestrator, no pipeline_run, no retries, no DB
// writes. Purpose: prove an LLM can turn real source_signal-shaped
// text into correctly-bounded Market node candidates BEFORE investing
// in the Orchestrator/DAG machinery (AI_AGENTS.md §1 contract; the
// same "de-risk the concept first" logic as MVP_IMPLEMENTATION_PLAN.md
// §4 risk 0, one layer deeper).
//
// IMPORTANT — Discovery's contract only ever reads
// search_signal | marketplace | industry_report | financial_signal
// evidence and only ever produces Market nodes. It does NOT read
// review/complaint content and does NOT produce Problem nodes — that
// is Expansion's job (expansionSandbox.ts). Feeding this sandbox
// complaint text would test the wrong agent boundary.
import { z } from "zod";
import type { LLMClient } from "./llmClient";
import { parseLlmJson } from "./parseLlmJson";

// --- Input: documents matching Discovery's actual allowed source types ---
export interface DiscoveryInputDocument {
  id: string; // stands in for an evidence_id once this exists in the DB
  sourceType: "search_signal" | "marketplace" | "industry_report" | "financial_signal";
  text: string;
}

// --- Output schema — mirrors GRAPH_SCHEMA.md §2.2 Market fields,
//     plus evidence_refs (which input doc ids support this market),
//     since AI_AGENTS.md §1's invariant is "MUST NOT create a market
//     row with zero node_source_refs rows." A sandbox output with an
//     empty evidence_refs array is treated as a Bounded-Rule violation
//     below, not silently accepted. ---
const MarketCandidateSchema = z.object({
  label: z.string().min(1),
  market_size_estimate: z.number().nullable(),
  growth_rate_estimate: z.number().nullable(),
  maturity_stage: z.enum(["emerging", "growing", "mature", "declining"]),
  category_tags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  evidence_refs: z.array(z.string()).min(1), // enforced non-empty — see comment above
});

const DiscoveryOutputSchema = z.object({
  markets: z.array(MarketCandidateSchema),
});

export type DiscoveryOutput = z.infer<typeof DiscoveryOutputSchema>;

const SYSTEM_PROMPT = `You are the Discovery Agent in a larger opportunity-evaluation system.

Your ONLY job: extract candidate Market nodes from the provided documents.

Rules you MUST follow exactly:
- You read ONLY the documents given to you. Do not use outside knowledge about companies, markets, or trends not present in the text.
- Every market you output MUST cite at least one input document id in evidence_refs. If you cannot point to specific text supporting a market, do not include it.
- You extract structure. You do NOT rank, filter, judge desirability, or recommend anything.
- You do NOT invent numbers. If a document doesn't state a market size or growth rate, use null — never estimate or guess.
- Output volume bias: prefer including a plausible market candidate over omitting it, but every single one still needs a real evidence_ref. High volume, low confidence is fine; volume with zero grounding is not.

Respond with ONLY valid JSON matching this exact shape. Your response MUST begin with { and end with }. Do not include any explanation, preamble, commentary, or markdown formatting before or after the JSON object — not even a single word:
{
  "markets": [
    {
      "label": string,
      "market_size_estimate": number | null,
      "growth_rate_estimate": number | null,
      "maturity_stage": "emerging" | "growing" | "mature" | "declining",
      "category_tags": string[],
      "confidence": number (0 to 1),
      "evidence_refs": string[]  // document ids from the input, non-empty
    }
  ]
}`;

function buildUserPrompt(documents: DiscoveryInputDocument[]): string {
  const docBlocks = documents
    .map((d) => `[document id="${d.id}" source_type="${d.sourceType}"]\n${d.text}\n[/document]`)
    .join("\n\n");
  return `Here are the documents:\n\n${docBlocks}`;
}

export interface DiscoverySandboxResult {
  rawResponse: string;
  parsed: DiscoveryOutput | null;
  validationErrors: string[];
  boundedRuleViolations: string[]; // markets that parsed fine per schema but still violate AI_AGENTS.md §1 invariants
}

export async function runDiscoverySandbox(
  llm: LLMClient,
  documents: DiscoveryInputDocument[]
): Promise<DiscoverySandboxResult> {
  const userPrompt = buildUserPrompt(documents);
  const rawResponse = await llm.complete(SYSTEM_PROMPT, userPrompt);

  let parsed: DiscoveryOutput | null = null;
  const validationErrors: string[] = [];
  const boundedRuleViolations: string[] = [];

  const parseResult = parseLlmJson(rawResponse);
  if (parseResult.error) {
    validationErrors.push(parseResult.error);
  } else {
    const result = DiscoveryOutputSchema.safeParse(parseResult.data);
    if (result.success) {
      parsed = result.data;
      const validDocIds = new Set(documents.map((d) => d.id));
      for (const market of parsed.markets) {
        const badRefs = market.evidence_refs.filter((ref) => !validDocIds.has(ref));
        if (badRefs.length > 0) {
          boundedRuleViolations.push(
            `Market "${market.label}" cites evidence_refs not present in input: ${badRefs.join(", ")} — hallucinated citation`
          );
        }
      }
    } else {
      validationErrors.push(result.error.toString());
    }
  }

  return { rawResponse, parsed, validationErrors, boundedRuleViolations };
}
