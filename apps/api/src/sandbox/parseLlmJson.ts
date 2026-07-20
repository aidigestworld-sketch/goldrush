// Shared LLM-JSON-response parser with a jsonrepair fallback.
//
// Motivation: mid-tier models (Nemotron-nano-9b, the primary
// NIM model this project uses) periodically emit malformed JSON that
// native JSON.parse rejects. Observed failure modes:
//   - Prose preamble ("Here is the JSON: {...}") — handled by
//     extractAndClean (first-{-to-last-} slice).
//   - Mid-string truncation: model stops emitting before the closing
//     `"` / `]` / `}`, even when max_tokens is not exhausted (log
//     60f84683-... on 2026-07-15: 5565 chars ended mid-note-string,
//     jsonrepair recovered 21 well-formed classified_evidence items).
//   - Unescaped quotes inside string values (verbatim-quote fields
//     that themselves contain a `"` character).
//   - Trailing commas.
//   - Missing closing brackets.
//
// jsonrepair handles all of the above. Pattern extracted from
// expansionSandbox.ts's existing (correctly-designed) tryParse so every
// LLM-facing sandbox can share the same recovery path instead of each
// re-inventing it (or, in most current sandboxes, not having it at all).

import { jsonrepair } from "jsonrepair";

// Strip prose preamble and markdown fences ("Here is the JSON:\n```\n{...}").
// Returns the substring from the first `{` to the last `}`, or a
// fence-stripped version if no braces are found (defensive fallback).
export function extractAndClean(raw: string): string {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) return raw.slice(first, last + 1);
  return raw.trim().replace(/^```json\s*/i, "").replace(/```\s*$/, "");
}

export interface ParseLlmJsonResult<T = unknown> {
  data: T | null;
  // true iff the native JSON.parse failed and jsonrepair had to be
  // applied. Callers plumb this to observability so we can tell which
  // model runs produced malformed output that we papered over.
  repaired: boolean;
  // Populated only when BOTH native parse AND jsonrepair failed —
  // the whole response is unrecoverable and the caller should surface
  // a schema-validation error.
  error: string | null;
}

// Try to produce a parsed JS value from a raw model response.
// Steps: extractAndClean → JSON.parse → on failure, jsonrepair → JSON.parse.
// Returns null data + error string only when both fall through.
export function parseLlmJson<T = unknown>(raw: string): ParseLlmJsonResult<T> {
  const cleaned = extractAndClean(raw);

  try {
    return { data: JSON.parse(cleaned) as T, repaired: false, error: null };
  } catch {
    // fall through to repair
  }

  try {
    const fixed = jsonrepair(cleaned);
    return { data: JSON.parse(fixed) as T, repaired: true, error: null };
  } catch (repairErr) {
    return {
      data: null,
      repaired: false,
      error: `JSON parse failed AND jsonrepair fallback also failed: ${(repairErr as Error).message}`,
    };
  }
}
