// Data Pipeline capability: "given a hypothesis, actively search for
// mechanism-specific evidence" — the missing half of Validation
// Collector's §6 contract (AI_AGENTS.md), unblocked by the Tavily
// connector.
//
// Architectural constraint (§20.2): Validation Collector does NOT call
// this file's dependencies (TavilyClient, connector, normalizer)
// directly. It calls THIS function, which owns the search + normalize
// steps. Data Pipeline stays a separate non-agent subsystem — search
// (this file) and classification (validationSandbox.ts's LLM call)
// stay two distinct steps, per Revision B's search-vs-grading split.
//
// Query strategy — DOUBLED QUERY (raw + reformulated):
//   When a reformulation LLM is supplied via options.reformulationLlm,
//   this capability issues TWO Tavily calls per hypothesis:
//     (1) with the raw hypothesis.statement — same as MVP baseline;
//     (2) with a mechanism-specific yes/no question produced by
//         reformulateHypothesisQuestion (extracted from Confidence
//         Agent's V8 Step 1).
//   Bench evidence (experimentReformulationForSearch.ts): on real
//   hypothesis input, the two result sets have ~0% URL overlap and
//   the reformulated query roughly doubles competitor-naming rate
//   (2/10 → 4/10) with some new regulatory-adjacent noise the
//   downstream classifier handles by marking inconclusive. Merging
//   both sets captures the union.
//   When no reformulation LLM is supplied, this capability still
//   works — single query with the raw statement, unchanged from
//   before. This backward-compat path exists so downstream tooling
//   and tests that don't want to construct an LLM can still exercise
//   the search capability.
//
// Dedup: after both queries, results are deduped by exact URL match.
// Order preserved: raw-query results first, then reformulated-query
// results not seen in the raw set. In practice URL overlap is near
// zero, but the dedup is real code, not an assumption.
//
// Search-log durability: pipeline_search_log (migration 004). Each
// Tavily call inserts ONE row — so a doubled query produces two rows
// per hypothesis, same run_id/hypothesis_id, different query_text.
// This preserves audit fidelity: a reviewer can see exactly which
// query strings were executed, not a merged/opaque composite.
import type { NormalizedEvidence } from "./types";
import { TavilyClient } from "./tavilyClient";
import { TavilySearchConnector } from "./connectors/tavilySearch.connector";
import { normalizeTavilySearchResult } from "./normalizers/tavilySearch.normalizer";
import { reformulateHypothesisQuestion } from "./reformulateHypothesisQuestion";
import { pipelineSearchLogRepository } from "../repositories/pipelineSearchLog.repository";
import type { LLMClient } from "../sandbox/llmClient";

export interface HypothesisSearchContext {
  runId: string;
  hypothesisId: string;
  hypothesisStatement: string;
}

export interface HypothesisSearchLogPayload {
  runId: string;
  hypothesisId: string;
  connector: string;
  queryText: string;
  resultCount: number;
  executedAt: Date;
}

export interface HypothesisSearchResult {
  rawResults: {
    title: string;
    url: string;
    content: string;
    score: number;
    publishedDate: string | null;
  }[];
  normalized: NormalizedEvidence[];
  // One entry per Tavily call actually issued (1 or 2). The audit
  // trail per §6 keeps these separate so the reviewer sees exactly
  // which query strings ran, not a merged composite.
  searchLogPayloads: HypothesisSearchLogPayload[];
}

export interface SearchForHypothesisEvidenceOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  includeDomains?: string[];
  excludeDomains?: string[];
  // When present, a second Tavily call is issued using this LLM to
  // reformulate hypothesis.statement into a mechanism-specific yes/no
  // question. When absent, only the raw-statement query runs (the
  // pre-doubled-query behavior, preserved so tests/tools that don't
  // want an LLM can still call this capability).
  reformulationLlm?: LLMClient;
}

interface OneQueryOutput {
  rawResults: HypothesisSearchResult["rawResults"];
  normalized: NormalizedEvidence[];
  logPayload: HypothesisSearchLogPayload;
}

async function issueSingleQuery(
  connector: TavilySearchConnector,
  queryText: string,
  context: HypothesisSearchContext
): Promise<OneQueryOutput> {
  const rawDocs = await connector.fetch(queryText);
  const executedAt = new Date();

  const normalized: NormalizedEvidence[] = [];
  const rawResults: HypothesisSearchResult["rawResults"] = [];
  for (const doc of rawDocs) {
    const payload = JSON.parse(doc.rawContent) as {
      title: string;
      url: string;
      content: string;
      score: number;
      publishedDate: string | null;
    };
    rawResults.push(payload);
    normalized.push(...normalizeTavilySearchResult(doc.rawContent, doc.sourceUrlOrIdentifier, doc.fetchedAt));
  }

  const logPayload: HypothesisSearchLogPayload = {
    runId: context.runId,
    hypothesisId: context.hypothesisId,
    connector: connector.name,
    queryText,
    resultCount: rawResults.length,
    executedAt,
  };
  await pipelineSearchLogRepository.create(logPayload);

  return { rawResults, normalized, logPayload };
}

export async function searchForHypothesisEvidence(
  context: HypothesisSearchContext,
  options: SearchForHypothesisEvidenceOptions = {}
): Promise<HypothesisSearchResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "TAVILY_API_KEY is not set — the search-capable half of Validation Collector cannot run without it. " +
        "Set it in apps/api/.env (same pattern as NVIDIA_API_KEY) before invoking this capability."
    );
  }
  const client = new TavilyClient(apiKey);
  const connector = new TavilySearchConnector(client, {
    maxResults: options.maxResults ?? 10,
    searchDepth: options.searchDepth ?? "advanced",
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
  });

  const rawQuery = await issueSingleQuery(connector, context.hypothesisStatement, context);
  const logPayloads: HypothesisSearchLogPayload[] = [rawQuery.logPayload];
  const seenUrls = new Set<string>(rawQuery.rawResults.map((r) => r.url));
  const mergedRawResults: HypothesisSearchResult["rawResults"] = [...rawQuery.rawResults];
  const mergedNormalized: NormalizedEvidence[] = [...rawQuery.normalized];

  if (options.reformulationLlm) {
    // If the reformulation call itself throws (LLM hiccup, transient
    // NIM 500), we propagate — Validation Collector's own retry
    // policy (AGENT_EXECUTION_DAG.md §4, up to 3 attempts on
    // LLM-based stages) will handle it. Silent fallback to raw-only
    // would hide a real signal in the retry logs.
    const reformulatedQuestion = await reformulateHypothesisQuestion(
      options.reformulationLlm,
      context.hypothesisStatement
    );
    const reformulatedQuery = await issueSingleQuery(connector, reformulatedQuestion, context);
    logPayloads.push(reformulatedQuery.logPayload);

    // Dedup by exact URL. Bench observed ~0% overlap on real data,
    // but this is real code, not an assumption.
    for (let i = 0; i < reformulatedQuery.rawResults.length; i++) {
      const r = reformulatedQuery.rawResults[i];
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      mergedRawResults.push(r);
      // Match the normalized entry that came from this raw result.
      // normalizeTavilySearchResult always returns a single-element
      // array (one NormalizedEvidence per Tavily result), so index
      // alignment matches raw ↔ normalized 1:1.
      mergedNormalized.push(reformulatedQuery.normalized[i]);
    }
  }

  return {
    rawResults: mergedRawResults,
    normalized: mergedNormalized,
    searchLogPayloads: logPayloads,
  };
}
