// Real NIM (build.nvidia.com) client — OpenAI-compatible endpoint,
// confirmed via docs.nvidia.com/nim and NVIDIA's own examples:
// https://integrate.api.nvidia.com/v1/chat/completions, Bearer auth
// with an nvapi-... key.
//
// This implements the same LLMClient interface as
// AnthropicLLMClient (llmClient.ts) — swapping between them is a
// one-line change, by design. This is the client production
// Discovery/Expansion/CompetitiveAnalysis agents should actually use,
// per model_routing_config's nim_model_id per agent.
import { Agent } from "undici";
import type { LLMClient } from "./llmClient";

export class NimLLMClient implements LLMClient {
  // nvidia/nvidia-nemotron-nano-9b-v2 max output ceiling is 32768 tokens
  // (per NVIDIA API docs). 16384 is the new default — half the ceiling,
  // enough headroom for Discovery (large markets[] arrays) and Expansion
  // (problems[] with verbatim quote fields) without risk of a hard API
  // error. Raised from 4096 which was truncating Discovery live runs.
  static readonly DEFAULT_MAX_TOKENS = 16384;

  // `model` and `maxTokens` are readable (not `private`) so llmFactory
  // tests and observability code can inspect what a constructed client
  // is actually pointed at, without duplicating the constructor arg list
  // in an accessor.
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string = "https://integrate.api.nvidia.com/v1",
    readonly maxTokens: number = NimLLMClient.DEFAULT_MAX_TOKENS
  ) {}

  // Per-attempt ceiling. Raised from 10 to 15 min because legitimate
  // large-max_tokens completions on the 49B model have been observed at
  // 2–9 min, and NIM does NOT stream — the server buffers the full
  // completion before returning headers, so a slow generation blocks
  // headers for the entire generation time. 15 min gives ~67% headroom
  // over the observed 9-min worst case.
  static readonly TIMEOUT_MS = 15 * 60 * 1000;

  // undici's default headersTimeout is 300000 ms (5 min) in Node 20+/
  // undici 5+ (still 5 min in undici 7.x bundled with Node 24). NIM
  // completions that generate 16384 tokens routinely exceed that.
  // Symptom: `TypeError: fetch failed` caused by `HeadersTimeoutError
  // (code=UND_ERR_HEADERS_TIMEOUT)`. Original incident: 07:38 UTC
  // 2026-07-14, Validation step on run 7209197f.
  //
  // Set both headersTimeout and bodyTimeout slightly ABOVE TIMEOUT_MS
  // so the AbortController fires FIRST — that produces the clearer
  // "aborted at TIMEOUT_MS" error message instead of undici's opaque
  // HeadersTimeoutError. 60 s buffer is enough for the abort signal to
  // propagate through undici's internal queue.
  //
  // Scoped to this client only via `dispatcher:`. Tavily and everything
  // else keep undici's global defaults — search responses are sub-
  // second and don't need this much slack.
  static readonly HEADERS_TIMEOUT_MS = NimLLMClient.TIMEOUT_MS + 60_000;
  static readonly BODY_TIMEOUT_MS = NimLLMClient.TIMEOUT_MS + 60_000;

  private static readonly dispatcher = new Agent({
    headersTimeout: NimLLMClient.HEADERS_TIMEOUT_MS,
    bodyTimeout: NimLLMClient.BODY_TIMEOUT_MS,
  });

  // ── Process-wide NIM call guards (concurrency + rate-limit) ─────────────
  //
  // Motivating incident: the 2026-07-17 hit-rate study fired ~50 sequential
  // NIM calls across ~42 min from a single tenant and hit cascading 504s —
  // first Validation on 49B v1.5, then Discovery on nano-9b-v2. The
  // cascade wasn't concurrent-call driven (max 1-3 in flight at any moment
  // via the batching wrapper); it was rate-over-time exhaustion of NIM's
  // per-tenant quota window.
  //
  // Two complementary guards, both in-process (matches the single-process
  // server + workers architecture in src/api/server.ts):
  //
  //   A. Concurrency semaphore — caps total concurrent NIM calls across
  //      every queue and every batched-sandbox call. Defends against the
  //      "N paying founders trigger runs simultaneously" case that
  //      queue-level concurrency=1 does not.
  //   B. Rolling-window rate limiter — caps requests per WINDOW_MS across
  //      all clients. Defends against the actual observed cascade (rate
  //      exhaustion over a long-running session).
  //
  // Both are queue-and-wait, not reject. Calls that hit either cap await
  // until a slot frees up — same non-destructive philosophy the rest of
  // the pipeline uses (BullMQ retries, batched Validation fail-loud, etc.).
  // Env-configurable so tuning doesn't need a code change.

  static get MAX_CONCURRENT_CALLS(): number {
    return Number(process.env.NIM_MAX_CONCURRENT_CALLS ?? 2);
  }
  static get MAX_REQUESTS_PER_MINUTE(): number {
    return Number(process.env.NIM_MAX_REQUESTS_PER_MINUTE ?? 15);
  }
  // Window is fixed at 60s in prod but overridable for tests via a static
  // setter (see resetGuardsForTests). Not env-configurable in prod because
  // "requests per minute" is the durable spec — the window IS a minute.
  private static _windowMsForTests: number | null = null;
  static get WINDOW_MS(): number {
    return NimLLMClient._windowMsForTests ?? 60_000;
  }

  private static inFlight = 0;
  private static concurrencyWaiters: Array<() => void> = [];
  private static requestTimestamps: number[] = [];

  // Test-only. Prod code never calls this — the guards are process-scoped
  // and should never be reset while requests are in flight. Tests reset
  // between cases so state doesn't leak across them.
  static resetGuardsForTests(opts?: { windowMs?: number | null }): void {
    NimLLMClient.inFlight = 0;
    NimLLMClient.concurrencyWaiters = [];
    NimLLMClient.requestTimestamps = [];
    if (opts && "windowMs" in opts) {
      NimLLMClient._windowMsForTests = opts.windowMs ?? null;
    }
  }

  private static async acquireConcurrencyPermit(): Promise<void> {
    while (NimLLMClient.inFlight >= NimLLMClient.MAX_CONCURRENT_CALLS) {
      await new Promise<void>((resolve) => NimLLMClient.concurrencyWaiters.push(resolve));
    }
    NimLLMClient.inFlight++;
  }

  private static releaseConcurrencyPermit(): void {
    NimLLMClient.inFlight--;
    const next = NimLLMClient.concurrencyWaiters.shift();
    if (next) next();
  }

  // Sliding-window rate limiter. Trims timestamps outside the window,
  // then either records a new one (slot available) or waits until the
  // oldest one slides out.
  private static async acquireRateSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      const windowStart = now - NimLLMClient.WINDOW_MS;
      while (
        NimLLMClient.requestTimestamps.length > 0 &&
        NimLLMClient.requestTimestamps[0] <= windowStart
      ) {
        NimLLMClient.requestTimestamps.shift();
      }
      if (NimLLMClient.requestTimestamps.length < NimLLMClient.MAX_REQUESTS_PER_MINUTE) {
        NimLLMClient.requestTimestamps.push(now);
        return;
      }
      const waitMs = Math.max(1, NimLLMClient.requestTimestamps[0] + NimLLMClient.WINDOW_MS - now);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    // Order: concurrency first, then rate-slot. This way a burst of N calls
    // naturally throttles at the concurrency door — the rate-slot timestamp
    // is only recorded when we're actually about to fire, not for calls
    // still parked behind the semaphore. Prevents phantom rate-slot usage.
    //
    // Instrumentation: log guard state before/after each call so we can
    // empirically confirm whether inFlight leaks or the rate-limit window
    // queues us. Post-mortem answer for the 2026-07-18 hit-rate study's
    // 302,300 ms discovery timeouts — see runDiscoveryReproTest.ts.
    const t0 = Date.now();
    const preInFlight = NimLLMClient.inFlight;
    const preWindow = NimLLMClient.requestTimestamps.filter(
      (t) => t > Date.now() - NimLLMClient.WINDOW_MS
    ).length;
    console.log(
      `[NIM] start  inFlight=${preInFlight}  window=${preWindow}/${NimLLMClient.MAX_REQUESTS_PER_MINUTE}  model=${this.model}`
    );
    await NimLLMClient.acquireConcurrencyPermit();
    const acqConc = Date.now();
    try {
      await NimLLMClient.acquireRateSlot();
      const acqRate = Date.now();
      try {
        const out = await this.doFetch(systemPrompt, userPrompt);
        console.log(
          `[NIM] ok    totalMs=${Date.now() - t0}  concQ=${acqConc - t0}  rateQ=${acqRate - acqConc}  fetchMs=${Date.now() - acqRate}`
        );
        return out;
      } catch (e) {
        console.log(
          `[NIM] FAIL  totalMs=${Date.now() - t0}  concQ=${acqConc - t0}  rateQ=${acqRate - acqConc}  fetchMs=${Date.now() - acqRate}  err=${(e as Error).message.slice(0, 100)}`
        );
        throw e;
      }
    } finally {
      NimLLMClient.releaseConcurrencyPermit();
    }
  }

  private async doFetch(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NimLLMClient.TIMEOUT_MS);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      signal: controller.signal,
      // @ts-expect-error - Node's fetch RequestInit accepts a dispatcher
      // from undici even though the DOM RequestInit type does not.
      dispatcher: NimLLMClient.dispatcher,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2, // low temperature — this is structured extraction, not creative generation
        max_tokens: this.maxTokens,
      }),
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      throw new Error(`NIM API error (model=${this.model}): ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason === "length") {
      // Throw immediately rather than returning truncated JSON — the caller
      // would receive malformed JSON that fails schema validation, producing
      // a confusing "Unexpected end of JSON input" error with no indication
      // of the real cause. Retrying at the same budget won't help; the error
      // message tells the operator exactly what to fix instead.
      throw new Error(
        `[NimLLMClient] model=${this.model} finish_reason=length — output truncated at max_tokens=${this.maxTokens}. ` +
          "Retrying with the same budget will not recover. Raise maxTokens or reduce input scope."
      );
    }
    return data.choices?.[0]?.message?.content ?? "";
  }
}
