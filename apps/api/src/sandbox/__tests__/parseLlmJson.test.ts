// Unit tests for parseLlmJson — the shared LLM-JSON parser with a
// jsonrepair fallback. Pins the recovery behaviour for the specific
// malformation classes observed in production so a future refactor
// can't silently regress.

import { describe, it, expect } from "vitest";
import { parseLlmJson, extractAndClean } from "../parseLlmJson";

describe("parseLlmJson", () => {
  it("well-formed JSON parses natively (repaired=false)", () => {
    const raw = '{"markets":[{"label":"foo"}]}';
    const result = parseLlmJson(raw);
    expect(result.error).toBeNull();
    expect(result.repaired).toBe(false);
    expect(result.data).toEqual({ markets: [{ label: "foo" }] });
  });

  it("prose preamble is stripped by extractAndClean", () => {
    const raw = 'Here is the JSON:\n{"ok":true}\nHope that helps!';
    const result = parseLlmJson(raw);
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: true });
  });

  it("markdown fence around JSON is stripped", () => {
    const raw = '```json\n{"ok":true}\n```';
    const result = parseLlmJson(raw);
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ ok: true });
  });

  it("mid-string truncation (the log 60f84683 / ba923046-class failure) is repaired via jsonrepair", () => {
    // The actual failure shape from the 07:34 UTC 2026-07-15 Validation
    // incident: response cut off mid-string inside the last array
    // element's `note` field. extractAndClean sliced back to the last
    // '}', which produced a "Expected ',' or ']' after array element
    // in JSON at position 5415" error under native JSON.parse. jsonrepair
    // fills in the missing brackets and produces a well-formed result.
    const raw = `{ "classified_evidence": [
      { "evidence_id": "25f22455-2430-4742-a1d5-9103cf9d0dd1", "classification": "supports", "note": "First item complete." },
      { "evidence_id": "d220419b-e92d-40e0-a12c-4808a8f0225f", "classification": "supports", "note": "This candidate explains Bold Subscriptions' features`;
    const result = parseLlmJson<{ classified_evidence: unknown[] }>(raw);
    expect(result.error).toBeNull();
    expect(result.repaired).toBe(true);
    expect(result.data?.classified_evidence).toBeDefined();
    // jsonrepair preserves the first, well-formed element (and typically
    // includes a placeholder for the truncated one).
    expect(result.data!.classified_evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("unescaped internal quotes inside a string value are repaired", () => {
    // The class of failure originally hypothesized for the ba923046 case
    // (turned out to be truncation instead). Still worth pinning because
    // Validation extracts verbatim evidence quotes that CAN contain " chars.
    const raw = `{ "quote": "She said "hello" to the crowd." }`;
    const result = parseLlmJson<{ quote: string }>(raw);
    expect(result.error).toBeNull();
    expect(result.repaired).toBe(true);
    expect(result.data?.quote).toContain("hello");
  });

  it("trailing comma before ] is repaired", () => {
    const raw = '{"items":["a","b","c",]}';
    const result = parseLlmJson<{ items: string[] }>(raw);
    expect(result.error).toBeNull();
    expect(result.repaired).toBe(true);
    expect(result.data?.items).toEqual(["a", "b", "c"]);
  });

  it("truly unrepairable input returns error (both native parse AND jsonrepair fail)", () => {
    // jsonrepair is very lenient — it repairs bare prose into a string
    // array if given prose with punctuation. To truly break both paths
    // we need input that has ambiguous braces without a coherent
    // structure. An empty string is the cleanest such case.
    const raw = "";
    const result = parseLlmJson(raw);
    expect(result.data).toBeNull();
    expect(result.error).toContain("JSON parse failed AND jsonrepair fallback also failed");
  });

  it("extractAndClean slices from first { to last }", () => {
    expect(extractAndClean('preamble {"a":1} tail')).toBe('{"a":1}');
    expect(extractAndClean('```json\n{"a":1}\n```')).toBe('{"a":1}');
    // no braces → trim() + fence strip (trailing newline preserved from the
    // implementation — jsonrepair still recovers content in the parse path,
    // so this exact string doesn't need to be pristine).
    expect(extractAndClean("```json\nno braces\n```")).toContain("no braces");
  });
});
