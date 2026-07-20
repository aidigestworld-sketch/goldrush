// Regression for the token-budget selector.
//
// Motivating incident: 07:34 UTC 2026-07-15 Discovery live run on
// shopify_subscriptions — 272 rows, ~508K chars, ~127K estimated tokens.
// NIM 400 error: "111617 input tokens requested against 111616 max".
// The fix: sort by (source_authority, recency, id) and drop the tail
// until the input fits under the budget.

import { describe, it, expect } from "vitest";
import {
  selectWithinTokenBudget,
  estimateTokens,
  DEFAULT_INPUT_TOKEN_BUDGET,
  PER_DOC_SCAFFOLD_TOKENS,
  type BudgetSelectableDoc,
} from "../tokenBudget";

// Simulated evidence corpus roughly matching the shopify_subscriptions
// state that broke Discovery: mostly search_signal (269 rows, ~1868
// chars each on average), plus a handful of industry_report /
// marketplace / financial_signal docs.
function buildOversizedCorpus(): BudgetSelectableDoc[] {
  const docs: BudgetSelectableDoc[] = [];
  const now = Date.now();
  // 269 search_signal rows, 1868 chars each ≈ 502K chars total, ~144K tokens.
  for (let i = 0; i < 269; i++) {
    docs.push({
      id: `search-${i.toString().padStart(3, "0")}`,
      sourceType: "search_signal",
      text: "s".repeat(1868),
      recencyAt: new Date(now - i * 60_000), // newer first
    });
  }
  // High-authority sources (industry_report is highest, then financial_signal, then marketplace).
  docs.push({
    id: "industry-report-0",
    sourceType: "industry_report",
    text: "i".repeat(450),
    recencyAt: new Date(now),
  });
  docs.push({
    id: "financial-signal-0",
    sourceType: "financial_signal",
    text: "f".repeat(248),
    recencyAt: new Date(now),
  });
  docs.push({
    id: "marketplace-0",
    sourceType: "marketplace",
    text: "m".repeat(361),
    recencyAt: new Date(now),
  });
  return docs;
}

describe("selectWithinTokenBudget", () => {
  it("empty input → empty output", () => {
    const r = selectWithinTokenBudget([]);
    expect(r.selected).toEqual([]);
    expect(r.droppedCount).toBe(0);
    expect(r.totalTokensEstimated).toBe(0);
  });

  it("fits entirely under the default budget → returns all docs, drops zero", () => {
    // 10 tiny docs, each ~100 chars = ~28 tokens + 40 scaffolding = ~68 tokens each.
    // Total ~680 tokens, well under 100K budget.
    const docs: BudgetSelectableDoc[] = Array.from({ length: 10 }, (_, i) => ({
      id: `doc-${i}`,
      sourceType: "search_signal",
      text: "x".repeat(100),
    }));
    const r = selectWithinTokenBudget(docs);
    expect(r.selected).toHaveLength(10);
    expect(r.droppedCount).toBe(0);
    expect(r.totalTokensEstimated).toBeGreaterThan(0);
    expect(r.totalTokensEstimated).toBeLessThan(1000);
  });

  it("oversized corpus (ba923046-class) → stays UNDER budget, drops the tail", () => {
    const corpus = buildOversizedCorpus();
    const r = selectWithinTokenBudget(corpus);

    // The whole corpus would blow past the budget — the selector must
    // drop the tail rather than include everything.
    expect(r.selected.length).toBeLessThan(corpus.length);
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.totalTokensEstimated).toBeLessThanOrEqual(DEFAULT_INPUT_TOKEN_BUDGET);
  });

  it("priority order: high-authority sources are never dropped when low-authority ones are", () => {
    const corpus = buildOversizedCorpus();
    const r = selectWithinTokenBudget(corpus);
    const selectedIds = new Set(r.selected.map((d) => d.id));

    // industry_report, financial_signal, marketplace are ~few in number
    // and short — must be in the selected set.
    expect(selectedIds.has("industry-report-0")).toBe(true);
    expect(selectedIds.has("financial-signal-0")).toBe(true);
    expect(selectedIds.has("marketplace-0")).toBe(true);

    // Dropped rows should be search_signal (lowest authority).
    for (const [srcType, count] of Object.entries(r.droppedBySourceType)) {
      expect(srcType).toBe("search_signal");
      expect(count).toBeGreaterThan(0);
    }
  });

  it("recency tiebreak: within the same source_type, newer docs are selected first", () => {
    // Build a corpus where only 2 out of 4 search_signal docs fit in the
    // budget. Newer ones (smaller i) should win.
    const now = Date.now();
    const docs: BudgetSelectableDoc[] = Array.from({ length: 4 }, (_, i) => ({
      id: `doc-${i}`,
      sourceType: "search_signal",
      text: "x".repeat(1000), // ~286 tokens + 40 = 326 tokens each
      recencyAt: new Date(now - i * 60_000),
    }));
    // Budget = enough for 2 docs but not 3.
    const r = selectWithinTokenBudget(docs, 700);
    expect(r.selected).toHaveLength(2);
    // Newest (doc-0, doc-1) selected; older (doc-2, doc-3) dropped.
    expect(r.selected.map((d) => d.id).sort()).toEqual(["doc-0", "doc-1"]);
  });

  it("deterministic id tiebreak when recency ties", () => {
    const sameTime = new Date();
    const docs: BudgetSelectableDoc[] = [
      { id: "z", sourceType: "search_signal", text: "z".repeat(500), recencyAt: sameTime },
      { id: "a", sourceType: "search_signal", text: "a".repeat(500), recencyAt: sameTime },
      { id: "m", sourceType: "search_signal", text: "m".repeat(500), recencyAt: sameTime },
    ];
    // Budget for 2 out of 3.
    const perDoc = estimateTokens("x".repeat(500)) + PER_DOC_SCAFFOLD_TOKENS;
    const r = selectWithinTokenBudget(docs, perDoc * 2 + 10);
    expect(r.selected).toHaveLength(2);
    // "a" and "m" (lex smallest) selected, "z" dropped.
    const selectedIds = r.selected.map((d) => d.id).sort();
    expect(selectedIds).toEqual(["a", "m"]);
  });

  it("estimateTokens: conservative — always returns >= real GPT token count for prose", () => {
    // For English prose, real tokenizers give ~4 chars/token. Our
    // estimator uses 3.5 chars/token, so it should over-count by ~14%.
    expect(estimateTokens("hello world")).toBeGreaterThanOrEqual(Math.ceil("hello world".length / 4));
  });

  it("estimateTokens: empty and edge cases", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
  });

  it("selection is complete: no partial-doc truncation (either the whole doc is kept or dropped)", () => {
    const corpus = buildOversizedCorpus();
    const r = selectWithinTokenBudget(corpus);
    // Every selected doc's text must be intact (not sliced).
    const originalById = new Map(corpus.map((d) => [d.id, d.text]));
    for (const s of r.selected) {
      expect(s.text).toBe(originalById.get(s.id));
    }
  });
});
