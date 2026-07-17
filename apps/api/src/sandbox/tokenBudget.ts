// Token-budget helpers for LLM inputs. Prevents the failure class where
// an agent blindly concatenates every eligible evidence row and blows
// past the model's context window (NIM 400 "111617 > 111616 max input"
// on the 07:34 UTC 2026-07-15 Discovery run — 272 rows / 508K chars
// / ~127K tokens for shopify_subscriptions, model context 128K, with
// max_tokens=16384 output reserved).
//
// Design:
//   1. Fast, conservative token count (chars / 3.5 heuristic — GPT/
//      Nemotron-family tokenizers average ~4 chars/token on English
//      prose; we round down to 3.5 for safety margin on URLs, code,
//      structured tokens, and non-ASCII content).
//   2. Deterministic priority ordering: (a) source authority, then
//      (b) recency (source_published_at || fetched_at), then (c)
//      stable id tiebreak. Higher-priority docs get in first.
//   3. Greedy selection: iterate docs in priority order, sum
//      per-doc tokens (including a fixed per-doc scaffolding overhead
//      for wrapping tags), stop when the next doc would exceed budget.
//   4. Return the selected list + a `droppedCount` so the caller can
//      log observability.
//
// NOT accurate to the byte — that's why the budget defaults leave a
// 10K+ token safety margin below the actual API-enforced limit. Precise
// tokenization would require pulling tiktoken/js-tiktoken which is not
// worth the dep + init cost for MVP.

// Conservative estimator. Empirical measurement on the 07:34 incident's
// evidence corpus: 508187 chars → 111617 tokens = 4.55 chars/token.
// English prose typically averages ~4. We round to 3.5 chars/token so
// our estimate consistently OVER-counts, i.e. we select fewer docs than
// the true budget would allow — safer than under-counting.
export const CHARS_PER_TOKEN_CONSERVATIVE = 3.5;

// Per-document scaffolding tokens: the wrapping tags
// `[document id="..." source_type="..."]\n{text}\n[/document]\n\n`.
// The tags + id + source_type + separators cost ~30 tokens per doc.
// Round to 40 for safety.
export const PER_DOC_SCAFFOLD_TOKENS = 40;

// Default Discovery / Expansion / CompetitiveAnalysis input budgets.
// Model context is 128K on the smallest Nemotron-family model this
// project uses; we reserve 16384 for max_tokens output + ~500 for the
// system prompt + ~5000 safety margin, leaving ~106000 for evidence.
// Round down to 100000 for a comfortable margin against tokenizer
// inaccuracy and any future model with a smaller window. This is the
// FALLBACK when the model is unknown — real per-model budgets are
// looked up via getInputTokenBudgetForModel() (see below).
export const DEFAULT_INPUT_TOKEN_BUDGET = 100_000;

// Strips the trailing NIM version suffix ("-v1", "-v1.5", "-v2", ...)
// from a NIM catalog id so per-model budget tuning survives a model
// point-release. Motivating incident: on 2026-07-17 the routing table
// swapped Validation from "-v1" to "-v1.5" to escape a gateway-timeout
// regression on the -v1 deployment. MODEL_INPUT_TOKEN_BUDGETS and
// AGENT_MODEL_INPUT_TOKEN_BUDGETS were both keyed by the exact NIM id
// including version — the rename silently missed the lookup and both
// fell back to the shared 100K default, dropping Validation's tighter
// 75K override (and inflating Validation's real input by 30K
// tokens — the opposite of what the switch was intended to do).
// A model class rarely changes its context-window budget across a
// point-release, so keying budgets by base name is both safer and more
// truthful about what the numbers actually track (the class's context
// window, not this-particular-deployment's).
export function baseModelKey(modelId: string): string {
  return modelId.replace(/-v\d+(?:\.\d+)*$/i, "");
}

// Per-model-CLASS input token budgets. Different NIM model classes this
// project routes to have different context windows — 128K on the
// nemotron-nano-9b class (Discovery / CompetitiveAnalysis / any
// low-cost slot), 131072 on the llama-3.3-nemotron-super-49b class
// (Hypothesis / Validation / Confidence / FounderFit / Expansion
// post-retier / Compression). Keyed by base model name (see
// baseModelKey) so a point-release rename inside a class doesn't
// silently drop the budget to DEFAULT.
//
// Formula per class: contextWindow - NimLLMClient.DEFAULT_MAX_TOKENS
// (16384 output) - 500 (system prompt) - 5000 (safety margin for
// tokenizer under-count, prompt scaffolding, etc.). Kept explicit
// per-class rather than computed at read time so the numbers here are
// grep-able and the safety margin is auditable in one place.
export const MODEL_INPUT_TOKEN_BUDGETS: Record<string, number> = {
  // 128000 - 16384 - 500 - 5000 = 106116; floor to 100000 to match the
  // shared DEFAULT — the nano class doesn't benefit from the extra ~6K.
  "nvidia/nvidia-nemotron-nano-9b": 100_000,
  // 131072 - 16384 - 500 - 5000 = 109188; floor to 105000 to preserve
  // ~4K margin above DEFAULT while staying comfortably under the real
  // ceiling. Covers -v1, -v1.5, and any future -v<N> point-releases in
  // the same class (base-model key match).
  "nvidia/llama-3.3-nemotron-super-49b": 105_000,
};

// Returns the appropriate input token budget for the model the LLM
// client is pointed at. Normalises the model id via baseModelKey so
// point-release variants (-v1, -v1.5, ...) all hit the same class
// entry. Falls back to DEFAULT_INPUT_TOKEN_BUDGET when the class is
// unknown (test doubles, ad-hoc scripts, or a yet-to-be-registered
// NIM catalog id) — a safe conservative default is preferable to
// throwing here, because a wrong-by-5K budget just drops a few extra
// rows, while a hard throw would block every agent call from a test
// harness or a live probe script.
export function getInputTokenBudgetForModel(modelId?: string | null): number {
  if (!modelId) return DEFAULT_INPUT_TOKEN_BUDGET;
  return MODEL_INPUT_TOKEN_BUDGETS[baseModelKey(modelId)] ?? DEFAULT_INPUT_TOKEN_BUDGET;
}

// Per-agent+model-class input token budget overrides. Layered ON TOP
// OF MODEL_INPUT_TOKEN_BUDGETS: an entry here trumps the model-only
// budget for that specific (agent, model-class) pair. Agents/classes
// NOT listed here fall through to the model-only budget. Keyed by
// base model name (see baseModelKey) — same rationale as
// MODEL_INPUT_TOKEN_BUDGETS: point-release renames must not drop the
// override.
//
// Validation on nvidia/llama-3.3-nemotron-super-49b* → 75_000 instead
// of the class-wide 105_000. Motivating incident: three consecutive
// NIM 504 gateway timeouts on this combination at ~105K input on
// 2026-07-16. NIM's shared gateway timeout is sensitive to prefill
// time (which scales ~linearly with input tokens); dropping this pair
// to 75K trades ~25–28% fewer classified candidates per Validation
// run (the lowest-authority + oldest ones, already deprioritized by
// the selector's ranking) for meaningfully less gateway pressure.
// Other agents on the same class keep 105K — they haven't shown the
// same failure mode.
const AGENT_MODEL_INPUT_TOKEN_BUDGETS: Record<string, Record<string, number>> = {
  Validation: {
    "nvidia/llama-3.3-nemotron-super-49b": 75_000,
  },
};

// Returns the appropriate input token budget for a specific (agent,
// model) pair. Lookup order (all model lookups normalised via
// baseModelKey so point-release renames don't silently drop overrides):
//   1. AGENT_MODEL_INPUT_TOKEN_BUDGETS[agent][baseModelKey(model)] — narrowest override
//   2. MODEL_INPUT_TOKEN_BUDGETS[baseModelKey(model)] — model-class-only override
//   3. DEFAULT_INPUT_TOKEN_BUDGET — fallback
//
// Agents that don't need agent-specific tuning can keep calling
// getInputTokenBudgetForModel(modelId) directly; agents that DO (only
// Validation right now) should call this to opt into the per-agent
// layer. Explicit at the call site rather than implicit so it's
// visible in the diff which agents are on which policy.
export function getInputTokenBudgetForAgent(
  agentName: string,
  modelId?: string | null
): number {
  if (modelId) {
    const perAgent = AGENT_MODEL_INPUT_TOKEN_BUDGETS[agentName];
    if (perAgent) {
      const byBase = perAgent[baseModelKey(modelId)];
      if (byBase !== undefined) return byBase;
    }
  }
  return getInputTokenBudgetForModel(modelId);
}

// Exported for tests only — lets a regression pin the exact override
// map contents without having to grep the source. Not intended for
// runtime use; call getInputTokenBudgetForAgent instead.
export const __AGENT_MODEL_INPUT_TOKEN_BUDGETS_FOR_TESTS = AGENT_MODEL_INPUT_TOKEN_BUDGETS;

// Source-type authority ranking. Higher-value sources get selected first
// when the budget forces truncation. Mirrors AI_AGENTS.md §1's implicit
// prioritization: industry reports and financial filings are the highest-
// signal Discovery inputs; search_signal is the noisiest, largest-volume
// tier and the first to be dropped under budget pressure.
const SOURCE_AUTHORITY_RANK: Record<string, number> = {
  industry_report: 4,
  financial_signal: 3,
  marketplace: 2,
  search_signal: 1,
  // fallback for unknown source_types
};

export interface BudgetSelectableDoc {
  id: string;
  sourceType: string;
  text: string;
  // Either sourcePublishedAt (preferred; when the source itself was
  // published) or fetchedAt (fallback; when we ingested it). Both are
  // acceptable — the ranker just uses whichever is provided as a
  // recency proxy.
  recencyAt?: Date | null;
}

export interface BudgetSelectionResult<T extends BudgetSelectableDoc> {
  selected: T[];
  droppedCount: number;
  droppedBySourceType: Record<string, number>;
  totalTokensEstimated: number;
  budgetTokens: number;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_CONSERVATIVE);
}

// Deterministic priority sort:
//   1. Source authority (higher first) — industry_report > financial_signal
//      > marketplace > search_signal > unknown.
//   2. Recency (newer first) via recencyAt.
//   3. Stable id tiebreak (lexicographic).
function compareForPriority<T extends BudgetSelectableDoc>(a: T, b: T): number {
  const aRank = SOURCE_AUTHORITY_RANK[a.sourceType] ?? 0;
  const bRank = SOURCE_AUTHORITY_RANK[b.sourceType] ?? 0;
  if (aRank !== bRank) return bRank - aRank;
  const aTs = a.recencyAt ? a.recencyAt.getTime() : 0;
  const bTs = b.recencyAt ? b.recencyAt.getTime() : 0;
  if (aTs !== bTs) return bTs - aTs;
  return a.id.localeCompare(b.id);
}

// Select as many docs as fit within budgetTokens, in priority order.
// Never partially truncates a doc — either the full doc is included
// or it's dropped whole. That preserves the "docs are units of evidence"
// contract Discovery / Expansion / CA rely on for citation grounding
// (a partially-truncated doc could break evidence_refs consistency).
export function selectWithinTokenBudget<T extends BudgetSelectableDoc>(
  docs: T[],
  budgetTokens: number = DEFAULT_INPUT_TOKEN_BUDGET
): BudgetSelectionResult<T> {
  const sorted = [...docs].sort(compareForPriority);
  const selected: T[] = [];
  const droppedBySourceType: Record<string, number> = {};
  let used = 0;
  let droppedCount = 0;
  for (const doc of sorted) {
    const docTokens = estimateTokens(doc.text) + PER_DOC_SCAFFOLD_TOKENS;
    if (used + docTokens > budgetTokens) {
      droppedCount++;
      droppedBySourceType[doc.sourceType] = (droppedBySourceType[doc.sourceType] ?? 0) + 1;
      continue;
    }
    selected.push(doc);
    used += docTokens;
  }
  return {
    selected,
    droppedCount,
    droppedBySourceType,
    totalTokensEstimated: used,
    budgetTokens,
  };
}
