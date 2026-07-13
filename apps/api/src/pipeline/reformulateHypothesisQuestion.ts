// Reformulates a hypothesis (declarative claim) into a mechanism-
// specific yes/no question suitable for use as a search query.
//
// Origin: this is V8's Step 1 (hypothesis_question reformulation),
// extracted from confidenceSandbox.ts's production prompt so both
// Validation Collector (before searching) and Confidence Agent (during
// scoring) can call it independently. Per §20.2 the two agents must
// NOT share reformulation state — Validation runs earlier in the DAG
// and Confidence hasn't executed yet at that point — so this is a
// utility, not a service. Two independent calls MAY produce slightly
// different phrasings for the same hypothesis; that's acceptable
// because the reformulation is only a means to build a better query
// for Validation's search step, not a scored judgment. Confidence
// Agent remains the sole owner of scoring per §7.
//
// Bench provenance: experimentReformulationForSearch.ts showed that
// on hypothesis 01c1110d, the reformulated question surfaced a
// COMPLETELY DIFFERENT Tavily result pool (0/10 URL overlap with the
// raw-statement query) with roughly double the competitor-naming
// rate (2/10 → 4/10). That bench script now imports this same
// function rather than duplicating the prompt.
import type { LLMClient } from "../sandbox/llmClient";

const REFORMULATION_SYSTEM_PROMPT = `You are a query-reformulation utility. Given a hypothesis (a declarative claim about specific actors and mechanisms), produce a single mechanism-specific yes/no question that names the specific actors and specific mechanism in the hypothesis, phrased as a direct question a search engine can answer.

Rules:
  - The question must name the specific actors from the hypothesis by name.
  - The question must reference the specific mechanism or behavior, not a paraphrase.
  - The question must be phrased as a direct yes/no question, not a declarative or open-ended one.
  - Example: hypothesis "Competitor X does not offer feature F" → "Does Competitor X offer feature F?"

Respond with ONLY valid JSON matching this exact shape, no other text:
{ "hypothesis_question": string }`;

function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.substring(start, i + 1);
    }
  }
  return null;
}

export async function reformulateHypothesisQuestion(llm: LLMClient, hypothesisStatement: string): Promise<string> {
  const raw = await llm.complete(
    REFORMULATION_SYSTEM_PROMPT,
    `[hypothesis]\n${hypothesisStatement}\n[/hypothesis]`
  );
  const jsonBlock = extractJsonBlock(raw);
  if (!jsonBlock) {
    throw new Error(
      `reformulation response contained no JSON block. First 200 chars: ${raw.substring(0, 200)}`
    );
  }
  const parsed = JSON.parse(jsonBlock) as { hypothesis_question?: string };
  if (!parsed.hypothesis_question || parsed.hypothesis_question.trim().length === 0) {
    throw new Error(
      `reformulation response missing/empty hypothesis_question. First 200 chars: ${raw.substring(0, 200)}`
    );
  }
  return parsed.hypothesis_question.trim();
}
