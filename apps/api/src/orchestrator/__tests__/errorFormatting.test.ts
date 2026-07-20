// Regression tests for formatErrorForStorage — the helper that captures
// Node/undici's .cause chain before we persist errors to dag_run_state.
//
// The 07:38 UTC 2026-07-14 incident stored "fetch failed" in
// dag_run_state.last_error with the underlying ECONNREFUSED / ENOTFOUND
// / ETIMEDOUT code silently lost inside .cause. These tests pin the
// helper's behaviour for the specific error shapes undici and node:net
// emit so a future refactor can't regress the same information loss.

import { describe, it, expect } from "vitest";
import { formatErrorForStorage, isNimGatewayTimeout } from "../errorFormatting";

describe("formatErrorForStorage", () => {
  it("single-level error: message + name", () => {
    const err = new Error("something broke");
    const out = formatErrorForStorage(err);
    expect(out).toBe("Error: something broke");
  });

  it("captures numeric/string code (undici-style) on the top-level error", () => {
    const err = new Error("connect ECONNREFUSED");
    (err as unknown as { code: string }).code = "ECONNREFUSED";
    const out = formatErrorForStorage(err);
    expect(out).toContain("code=ECONNREFUSED");
  });

  it("2-level nested cause: message + cause.message both preserved", () => {
    const inner = new Error("ENOTFOUND api.example.com");
    (inner as unknown as { code: string }).code = "ENOTFOUND";
    const outer = new Error("fetch failed");
    (outer as unknown as { cause: Error }).cause = inner;
    const out = formatErrorForStorage(outer);
    expect(out).toContain("fetch failed");
    expect(out).toContain("ENOTFOUND");
    expect(out).toContain("code=ENOTFOUND");
    expect(out).toContain("caused by:");
    // Ordering: top-level first, then the caused-by line.
    expect(out.indexOf("fetch failed")).toBeLessThan(out.indexOf("ENOTFOUND"));
  });

  it("3-level nested cause: full chain (message + cause + cause.cause) captured", () => {
    // Mirrors what undici actually throws for a socket-level DNS
    // failure: TypeError('fetch failed') → cause=TypeError('...') →
    // cause=Error('getaddrinfo ENOTFOUND', code=ENOTFOUND).
    const l3 = new Error("getaddrinfo ENOTFOUND some-host.internal");
    (l3 as unknown as { code: string }).code = "ENOTFOUND";
    const l2 = new TypeError("Failed to fetch");
    (l2 as unknown as { cause: Error }).cause = l3;
    const l1 = new TypeError("fetch failed");
    (l1 as unknown as { cause: Error }).cause = l2;

    const out = formatErrorForStorage(l1);
    expect(out).toContain("TypeError: fetch failed");
    expect(out).toContain("TypeError: Failed to fetch");
    expect(out).toContain("Error: getaddrinfo ENOTFOUND some-host.internal");
    expect(out).toContain("code=ENOTFOUND");
    // Two "caused by:" lines for 3-level nesting.
    expect((out.match(/caused by:/g) ?? []).length).toBe(2);
  });

  it("cycle detection: does not loop forever on circular cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as unknown as { cause: Error }).cause = b;
    (b as unknown as { cause: Error }).cause = a;
    const out = formatErrorForStorage(a);
    expect(out).toContain("<cycle>");
    expect(out.split("\n").length).toBeLessThanOrEqual(4);
  });

  it("non-Error thrown values: strings", () => {
    const out = formatErrorForStorage("bare-string-error");
    expect(out).toContain("bare-string-error");
  });

  it("non-Error thrown values: plain object with cause", () => {
    const out = formatErrorForStorage({ msg: "oops", cause: new Error("inner") });
    expect(out).toContain("object:");
    expect(out).toContain("Error: inner");
    expect(out).toContain("caused by:");
  });

  it("null / undefined handled without crashing", () => {
    expect(formatErrorForStorage(null)).toBe("");
    expect(formatErrorForStorage(undefined)).toBe("");
  });

  it("truncates at MAX_CAUSE_DEPTH to prevent runaway strings on deep chains", () => {
    // Build a 15-deep chain (exceeds MAX_CAUSE_DEPTH=10).
    let current: Error = new Error("bottom");
    for (let i = 0; i < 15; i++) {
      const wrapper = new Error(`level-${i}`);
      (wrapper as unknown as { cause: Error }).cause = current;
      current = wrapper;
    }
    const out = formatErrorForStorage(current);
    expect(out).toContain("<truncated");
  });
});

// isNimGatewayTimeout classifies errors for the worker's fail-fast
// retry-skip path. False positives would silently skip legitimately-
// retryable errors; false negatives would let the worker burn all 3
// attempts against an overloaded NIM gateway. Pin the exact matching
// behavior for both.
describe("isNimGatewayTimeout", () => {
  it("matches the exact message NimLLMClient throws on 504", () => {
    // From nimLLMClient.ts: `NIM API error (model=${model}): 504 ${body}`
    const err = new Error(
      'NIM API error (model=nvidia/llama-3.3-nemotron-super-49b-v1): 504 <html>Gateway Timeout</html>'
    );
    expect(isNimGatewayTimeout(err)).toBe(true);
  });

  it("matches when the NIM 504 sits nested inside .cause (BullMQ wrap case)", () => {
    // BullMQ / undici can wrap the underlying NIM error — the fail-fast
    // detector must walk .cause to find the real cause. Otherwise a
    // wrapped 504 would be treated as a normal retryable error and
    // burn all 3 attempts against the overloaded gateway.
    const inner = new Error("NIM API error (model=nvidia/nano): 504 upstream timeout");
    const outer = new Error("worker handler threw");
    (outer as unknown as { cause: Error }).cause = inner;
    expect(isNimGatewayTimeout(outer)).toBe(true);
  });

  it("does NOT match on other NIM error status codes (400, 429, 500, 503)", () => {
    // 400 = client error (bad prompt shape) — retrying makes no sense.
    //   BullMQ handles that separately; not this detector's concern.
    // 429 = rate limit — retrying WITH backoff is exactly the right
    //   thing to do, we must not fail-fast on this.
    // 500/503 = generic upstream error — could be transient; keep
    //   the normal retry budget.
    for (const status of [400, 429, 500, 503]) {
      const err = new Error(`NIM API error (model=x): ${status} something`);
      expect(isNimGatewayTimeout(err)).toBe(false);
    }
  });

  it("does NOT match on unrelated errors that happen to contain '504' incidentally", () => {
    // Guard against false positives: a body payload or unrelated error
    // that just mentions "504" somewhere shouldn't trigger fail-fast.
    // The regex requires the exact "NIM API error ... : 504" shape.
    expect(isNimGatewayTimeout(new Error("connection reset (504 bytes read)"))).toBe(false);
    expect(isNimGatewayTimeout(new Error("port 5040 already in use"))).toBe(false);
    expect(isNimGatewayTimeout(new Error("Tavily rate limit: 504 requests/min exceeded"))).toBe(false);
  });

  it("does NOT match on network / DNS / JSON errors (must keep normal retries)", () => {
    // These are the retryable classes the worker's normal 3-attempt
    // budget was built for — fail-fast must NOT kick in.
    expect(isNimGatewayTimeout(new Error("fetch failed"))).toBe(false);
    expect(isNimGatewayTimeout(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isNimGatewayTimeout(new Error("Unexpected end of JSON input"))).toBe(false);
    expect(isNimGatewayTimeout(new Error("aborted at 900000ms"))).toBe(false);
  });

  it("handles non-Error thrown values without crashing", () => {
    expect(isNimGatewayTimeout(null)).toBe(false);
    expect(isNimGatewayTimeout(undefined)).toBe(false);
    expect(isNimGatewayTimeout("NIM API error (model=x): 504")).toBe(false); // strings don't match (require Error instance)
    expect(isNimGatewayTimeout({ message: "NIM API error (model=x): 504" })).toBe(false);
  });

  it("does not loop forever on a cyclic .cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as unknown as { cause: Error }).cause = b;
    (b as unknown as { cause: Error }).cause = a;
    // Should return false (no 504 anywhere) and terminate.
    expect(isNimGatewayTimeout(a)).toBe(false);
  });
});
