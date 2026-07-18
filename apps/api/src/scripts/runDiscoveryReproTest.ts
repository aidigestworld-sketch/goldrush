// Cheap isolated reproduction of the 2026-07-18 hit-rate study's
// discovery-timeout pattern (P3-P6 all failed at ~302,300 ms after
// P1-P2 succeeded). This test skips the DAG, BullMQ, and every other
// agent — it constructs the EXACT prompts Discovery would send in
// production (real evidence corpus via the same token-budget selection,
// wrapped in the same SYSTEM_PROMPT and buildUserPrompt() as
// discoverySandbox.ts) and fires them 6 times sequentially at a fresh
// NimLLMClient using the same model (nvidia/nvidia-nemotron-nano-9b-v2).
//
// Purpose: does "first 2 succeed, next 4 fail at ~302s" reproduce at the
// raw-call level? If yes → the pattern is at NIM's gateway / inference
// backend, not at anything the pipeline does around the call. If no →
// something in the full pipeline's resource usage (workers, DB pool,
// tavily interleaving, etc.) is triggering the pattern.
//
// The nimLLMClient.ts complete() method now logs inFlight, window
// occupancy, concQ / rateQ / fetchMs on every call — that output plus
// this driver's per-call summary is what answers the diagnostic.
//
// Run: npx tsx --env-file=.env src/scripts/runDiscoveryReproTest.ts
import { prisma } from "../db/client";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { runDiscoverySandbox, type DiscoveryInputDocument } from "../sandbox/discoverySandbox";
import { selectWithinTokenBudget, getInputTokenBudgetForModel } from "../sandbox/tokenBudget";
import type { LLMClient } from "../sandbox/llmClient";

const VERTICAL = "shopify_subscriptions";
const MODEL = "nvidia/nvidia-nemotron-nano-9b-v2";
const NUM_CALLS = 6;
const ALLOWED_SOURCE_TYPES = ["search_signal", "marketplace", "industry_report", "financial_signal"] as const;

// Capture LLM — records what the sandbox would send, returns a valid
// (empty) Discovery response so parseLlmJson doesn't blow up. We only
// need the captured strings.
class CaptureLLM implements LLMClient {
  captured: { systemPrompt: string; userPrompt: string } | null = null;
  model = "capture";
  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    this.captured = { systemPrompt, userPrompt };
    return JSON.stringify({ markets: [] });
  }
}

function estTokens(s: string): number {
  // Rough estimate — same 4-chars-per-token heuristic tokenBudget.ts uses.
  return Math.ceil(s.length / 4);
}

async function main() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");

  console.log("═══════════════════════════════════════════════════");
  console.log(`  DISCOVERY-SIZED NIM REPRO — ${NUM_CALLS} sequential calls`);
  console.log(`  vertical=${VERTICAL}  model=${MODEL}`);
  console.log("═══════════════════════════════════════════════════\n");

  // Step 1 — recreate Discovery's exact evidence selection.
  const evidenceRows = await prisma.evidence.findMany({
    where: {
      sourceType: { in: [...ALLOWED_SOURCE_TYPES] },
      status: "active",
      vertical: VERTICAL,
    },
  });
  console.log(`[setup] evidence rows for vertical: ${evidenceRows.length}`);

  const budgetResult = selectWithinTokenBudget(
    evidenceRows.map((e) => ({
      id: e.id,
      sourceType: e.sourceType,
      text: e.extractedFact,
      recencyAt: e.sourcePublishedAt ?? e.fetchedAt ?? null,
    })),
    getInputTokenBudgetForModel(MODEL),
  );
  console.log(
    `[setup] token-budget kept ${budgetResult.selected.length}/${evidenceRows.length} rows  ~${budgetResult.totalTokensEstimated} tokens  budget=${budgetResult.budgetTokens}`,
  );

  const documents: DiscoveryInputDocument[] = budgetResult.selected.map((e) => ({
    id: e.id,
    sourceType: e.sourceType as (typeof ALLOWED_SOURCE_TYPES)[number],
    text: e.text,
  }));

  // Step 2 — capture the exact system + user prompts Discovery would send.
  const capture = new CaptureLLM();
  await runDiscoverySandbox(capture, documents);
  if (!capture.captured) throw new Error("capture LLM did not receive a call");
  const { systemPrompt, userPrompt } = capture.captured;
  const promptTokens = estTokens(systemPrompt) + estTokens(userPrompt);
  console.log(
    `[setup] captured prompts: systemLen=${systemPrompt.length} userLen=${userPrompt.length} ~${promptTokens} tokens\n`,
  );

  // Step 3 — fire NUM_CALLS sequential calls at real NIM.
  const nim = new NimLLMClient(apiKey, MODEL);
  interface CallResult {
    idx: number;
    ok: boolean;
    ms: number;
    err?: string;
    outLen?: number;
  }
  const results: CallResult[] = [];

  for (let i = 0; i < NUM_CALLS; i++) {
    console.log(`──── call ${i + 1} ────`);
    const t0 = Date.now();
    try {
      const out = await nim.complete(systemPrompt, userPrompt);
      const ms = Date.now() - t0;
      results.push({ idx: i + 1, ok: true, ms, outLen: out.length });
      console.log(`  RESULT: OK   ${ms}ms  outLen=${out.length}\n`);
    } catch (e) {
      const ms = Date.now() - t0;
      const msg = (e as Error).message;
      results.push({ idx: i + 1, ok: false, ms, err: msg.slice(0, 200) });
      console.log(`  RESULT: FAIL ${ms}ms  err=${msg.slice(0, 200)}\n`);
    }
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════");
  console.log("idx | ok  |    ms | outLen | err");
  console.log("----+-----+-------+--------+----");
  for (const r of results) {
    console.log(
      [
        String(r.idx).padStart(3),
        (r.ok ? "OK " : "FAIL").padEnd(3),
        String(r.ms).padStart(5),
        r.outLen !== undefined ? String(r.outLen).padStart(6) : "     -",
        r.err ? r.err.slice(0, 60) : "",
      ].join(" | "),
    );
  }

  const nSucc = results.filter((r) => r.ok).length;
  const nFail = results.filter((r) => !r.ok).length;
  const failTimes = results.filter((r) => !r.ok).map((r) => r.ms);
  console.log(`\n  successes: ${nSucc}/${NUM_CALLS}  failures: ${nFail}/${NUM_CALLS}`);
  if (failTimes.length > 0) {
    const min = Math.min(...failTimes);
    const max = Math.max(...failTimes);
    console.log(`  failure-time range: ${min}ms → ${max}ms  (variance=${max - min}ms)`);
    console.log(`  hard-cutoff check: ${max - min < 500 ? "YES (variance <500ms → server-side cutoff)" : "NO (variable → not a hard cutoff)"}`);
  }
  console.log("");

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
