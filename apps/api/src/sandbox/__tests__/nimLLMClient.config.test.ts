// Config-level regression for NimLLMClient's undici timeouts.
//
// This test does NOT hit the real NIM endpoint — it only asserts the
// static constants that configure the client's dispatcher, so a future
// refactor can't silently drop the fix that resolved the 07:38 UTC
// 2026-07-14 Validation incident (`fetch failed` caused by
// `HeadersTimeoutError code=UND_ERR_HEADERS_TIMEOUT`).
//
// The actual behaviour (slow completion doesn't trip undici's 5-min
// default headersTimeout) can only be verified end-to-end against a
// real NIM call — see the live scripts in src/scripts/. What we CAN
// pin here is the invariant that:
//   1. HEADERS_TIMEOUT_MS > TIMEOUT_MS (so AbortController wins the
//      race, producing a clear error instead of undici's opaque one).
//   2. TIMEOUT_MS >= 15 minutes (headroom over the 2-9 min observed
//      NIM completion window for max_tokens=16384).
//   3. The dispatcher is a real undici Agent (not accidentally the
//      global default).

import { describe, it, expect } from "vitest";
import { Agent } from "undici";
import { NimLLMClient } from "../nimLLMClient";

describe("NimLLMClient timeout configuration", () => {
  it("TIMEOUT_MS is at least 15 minutes", () => {
    expect(NimLLMClient.TIMEOUT_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });

  it("HEADERS_TIMEOUT_MS is strictly greater than TIMEOUT_MS (so AbortController fires first)", () => {
    expect(NimLLMClient.HEADERS_TIMEOUT_MS).toBeGreaterThan(NimLLMClient.TIMEOUT_MS);
  });

  it("BODY_TIMEOUT_MS is strictly greater than TIMEOUT_MS (mirror invariant)", () => {
    expect(NimLLMClient.BODY_TIMEOUT_MS).toBeGreaterThan(NimLLMClient.TIMEOUT_MS);
  });

  it("HEADERS_TIMEOUT_MS exceeds undici's 5-minute default (the actual bug)", () => {
    const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;
    expect(NimLLMClient.HEADERS_TIMEOUT_MS).toBeGreaterThan(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
  });

  it("dispatcher (private static) is a constructed undici Agent", () => {
    // Access the private static field for the invariant check. We
    // deliberately don't expose it publicly — the assertion below reaches
    // through the type system on purpose so a production refactor that
    // drops the dispatcher trips the test.
    const dispatcher = (NimLLMClient as unknown as { dispatcher: unknown }).dispatcher;
    expect(dispatcher).toBeInstanceOf(Agent);
  });

  it("DEFAULT_MAX_TOKENS is 16384 — the value that necessitated raising the timeouts", () => {
    // Included so a future max_tokens change can't silently invalidate
    // the timeout assumptions in this file. If the ceiling gets lowered
    // or raised, someone will land here and re-evaluate.
    expect(NimLLMClient.DEFAULT_MAX_TOKENS).toBe(16384);
  });
});
