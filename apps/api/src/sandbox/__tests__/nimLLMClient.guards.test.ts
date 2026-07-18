// Concurrency-semaphore + rolling-window rate-limiter tests for
// NimLLMClient's process-wide NIM call guards.
//
// Motivating incident: the 2026-07-17 hit-rate study fired ~50 sequential
// NIM calls in ~42 min from one tenant and hit cascading 504s across two
// different model classes. Both guards live in NimLLMClient.complete()
// so every code path that talks to NIM is throttled uniformly.
//
// These tests use a stubbed global fetch — no real NIM calls, no network.
// The response payload matches the shape NimLLMClient.doFetch() extracts
// (choices[0].message.content).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NimLLMClient } from "../nimLLMClient";

interface FetchTracking {
  inFlight: number;
  peakInFlight: number;
  startTimes: number[];
}

// Build a fetch stub that:
//   - responds after `delayMs` (default 20ms) — controlled per call
//   - records concurrency + timing on the passed `tracking` object
function makeTrackedFetch(tracking: FetchTracking, delayMs = 20) {
  return async () => {
    tracking.inFlight++;
    tracking.peakInFlight = Math.max(tracking.peakInFlight, tracking.inFlight);
    tracking.startTimes.push(Date.now());
    await new Promise((r) => setTimeout(r, delayMs));
    tracking.inFlight--;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as Response;
  };
}

function newTracking(): FetchTracking {
  return { inFlight: 0, peakInFlight: 0, startTimes: [] };
}

function newClient(): NimLLMClient {
  return new NimLLMClient("fake-api-key", "test-model");
}

describe("NimLLMClient concurrency semaphore (Guard A)", () => {
  beforeEach(() => {
    // Reset shared static state so tests don't leak between cases
    NimLLMClient.resetGuardsForTests();
    delete process.env.NIM_MAX_CONCURRENT_CALLS;
    delete process.env.NIM_MAX_REQUESTS_PER_MINUTE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("5 simultaneous calls with default N=2: never more than 2 in-flight at once", async () => {
    expect(NimLLMClient.MAX_CONCURRENT_CALLS).toBe(2);
    const tracking = newTracking();
    vi.stubGlobal("fetch", makeTrackedFetch(tracking));

    const client = newClient();
    // Fire 5 concurrently; wait for all to resolve
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.complete("sys", "user"))
    );

    expect(results.length).toBe(5);
    expect(tracking.startTimes.length).toBe(5); // all 5 eventually fired
    expect(tracking.peakInFlight).toBeLessThanOrEqual(2);
    expect(tracking.peakInFlight).toBeGreaterThan(0);
  });

  it("respects NIM_MAX_CONCURRENT_CALLS=1 env override (only 1 at a time)", async () => {
    process.env.NIM_MAX_CONCURRENT_CALLS = "1";
    expect(NimLLMClient.MAX_CONCURRENT_CALLS).toBe(1);
    const tracking = newTracking();
    vi.stubGlobal("fetch", makeTrackedFetch(tracking));

    const client = newClient();
    await Promise.all(Array.from({ length: 4 }, () => client.complete("sys", "user")));

    expect(tracking.startTimes.length).toBe(4);
    expect(tracking.peakInFlight).toBe(1);
  });

  it("respects NIM_MAX_CONCURRENT_CALLS=4 env override (higher cap allowed)", async () => {
    process.env.NIM_MAX_CONCURRENT_CALLS = "4";
    expect(NimLLMClient.MAX_CONCURRENT_CALLS).toBe(4);
    const tracking = newTracking();
    vi.stubGlobal("fetch", makeTrackedFetch(tracking));

    const client = newClient();
    await Promise.all(Array.from({ length: 6 }, () => client.complete("sys", "user")));

    expect(tracking.peakInFlight).toBeLessThanOrEqual(4);
    // Should reach >2 (proving the env override worked, otherwise cap would be 2)
    expect(tracking.peakInFlight).toBeGreaterThan(2);
  });

  it("in-flight counter decrements even when fetch throws (finally block)", async () => {
    process.env.NIM_MAX_CONCURRENT_CALLS = "2";
    let callCount = 0;
    // First 2 calls throw, next 2 succeed. If the semaphore leaked on error,
    // calls 3-4 would deadlock waiting for the counter to drop.
    vi.stubGlobal("fetch", async () => {
      callCount++;
      if (callCount <= 2) throw new Error("simulated network fail");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      } as unknown as Response;
    });

    const client = newClient();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => client.complete("sys", "user"))
    );
    expect(results.filter((r) => r.status === "rejected").length).toBe(2);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
  });

  it("in-flight counter decrements when fetch RETURNS 504 (non-ok response, not thrown)", async () => {
    // Different failure mode from the "fetch throws" test above: the
    // production 504 path in doFetch() is `if (!response.ok) throw new
    // Error(...)` — the throw happens INSIDE our own code, AFTER fetch
    // resolves with a non-ok Response. Previous tests only exercised
    // `throw new Error()` from the fetch stub itself. The 2026-07-18
    // hit-rate study surfaced 4 discovery 504s and this test proves
    // that failure mode doesn't leak permits either.
    process.env.NIM_MAX_CONCURRENT_CALLS = "2";
    let callCount = 0;
    vi.stubGlobal("fetch", async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: false,
          status: 504,
          text: async () => "gateway timeout",
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      } as unknown as Response;
    });

    const client = newClient();
    // If a 504 return leaked a permit, calls 3-4 would deadlock forever
    // waiting for the phantom in-flight entries to drop. Await with a
    // ceiling — if we hang, the test times out rather than hangs the suite.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => client.complete("sys", "user"))
    );
    expect(results.filter((r) => r.status === "rejected").length).toBe(2);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
      expect(String(r.reason)).toMatch(/504/);
    }
  });
});

describe("NimLLMClient rolling-window rate limiter (Guard B)", () => {
  beforeEach(() => {
    // Shrink the window so tests run fast — real prod value is 60s.
    NimLLMClient.resetGuardsForTests({ windowMs: 500 });
    delete process.env.NIM_MAX_CONCURRENT_CALLS;
    delete process.env.NIM_MAX_REQUESTS_PER_MINUTE;
    // Give concurrency plenty of room so ONLY the rate limiter throttles.
    process.env.NIM_MAX_CONCURRENT_CALLS = "50";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NIM_MAX_CONCURRENT_CALLS;
    delete process.env.NIM_MAX_REQUESTS_PER_MINUTE;
    NimLLMClient.resetGuardsForTests({ windowMs: null });
  });

  it("15 calls within a fresh window all fire immediately", async () => {
    expect(NimLLMClient.MAX_REQUESTS_PER_MINUTE).toBe(15);
    const tracking = newTracking();
    vi.stubGlobal("fetch", makeTrackedFetch(tracking, 5));

    const client = newClient();
    const start = Date.now();
    await Promise.all(Array.from({ length: 15 }, () => client.complete("sys", "user")));
    const elapsed = Date.now() - start;

    expect(tracking.startTimes.length).toBe(15);
    // With 50 concurrency + 15 rate slots + 5ms fetch, all 15 should complete
    // well under the 500ms window. If any had queued on the rate limiter,
    // elapsed would exceed the 500ms WINDOW_MS.
    expect(elapsed).toBeLessThan(500);
  });

  it("16th call within the same window waits for a slot to expire", async () => {
    process.env.NIM_MAX_REQUESTS_PER_MINUTE = "3";
    NimLLMClient.resetGuardsForTests({ windowMs: 300 });
    expect(NimLLMClient.MAX_REQUESTS_PER_MINUTE).toBe(3);

    const tracking = newTracking();
    vi.stubGlobal("fetch", makeTrackedFetch(tracking, 5));

    const client = newClient();
    const t0 = Date.now();

    // Fire 3 calls (fills the window) and wait for them
    await Promise.all(Array.from({ length: 3 }, () => client.complete("sys", "user")));
    const timeAfter3 = Date.now() - t0;

    // Fire the 4th — it must wait for the oldest of the first 3 to slide out
    await client.complete("sys", "user");
    const timeAfter4 = Date.now() - t0;

    expect(tracking.startTimes.length).toBe(4);
    // First 3 fired fast. The 4th must have waited > (windowMs - timeAfter3)
    // for the earliest to slide out — well beyond the 5ms fetch time.
    expect(timeAfter4 - timeAfter3).toBeGreaterThan(200);
  });

  it("respects NIM_MAX_REQUESTS_PER_MINUTE env override", async () => {
    process.env.NIM_MAX_REQUESTS_PER_MINUTE = "5";
    expect(NimLLMClient.MAX_REQUESTS_PER_MINUTE).toBe(5);
  });
});

describe("NimLLMClient guards — composition (A + B together)", () => {
  beforeEach(() => {
    NimLLMClient.resetGuardsForTests({ windowMs: 500 });
    delete process.env.NIM_MAX_CONCURRENT_CALLS;
    delete process.env.NIM_MAX_REQUESTS_PER_MINUTE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NIM_MAX_CONCURRENT_CALLS;
    delete process.env.NIM_MAX_REQUESTS_PER_MINUTE;
    NimLLMClient.resetGuardsForTests({ windowMs: null });
  });

  it("call must clear BOTH the concurrency permit AND the rate-limit slot before fetching", async () => {
    // Tight-cap both mechanisms so we can observe interleaving.
    process.env.NIM_MAX_CONCURRENT_CALLS = "2";
    process.env.NIM_MAX_REQUESTS_PER_MINUTE = "3";
    NimLLMClient.resetGuardsForTests({ windowMs: 300 });

    const tracking = newTracking();
    vi.stubGlobal("fetch", makeTrackedFetch(tracking, 30));

    const client = newClient();
    // Fire 6 — concurrency cap 2, rate cap 3 per 300ms window.
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => client.complete("sys", "user")));
    const elapsed = Date.now() - t0;

    // All 6 must complete
    expect(tracking.startTimes.length).toBe(6);
    // Concurrency invariant held throughout
    expect(tracking.peakInFlight).toBeLessThanOrEqual(2);
    // With rate cap 3/window and 6 calls, at least 2 windows are involved,
    // so total elapsed must exceed one full window boundary.
    expect(elapsed).toBeGreaterThan(200);
  });

  it("neither guard leaks when a fetch throws mid-sequence", async () => {
    process.env.NIM_MAX_CONCURRENT_CALLS = "2";
    process.env.NIM_MAX_REQUESTS_PER_MINUTE = "10";
    NimLLMClient.resetGuardsForTests({ windowMs: 500 });

    let callCount = 0;
    vi.stubGlobal("fetch", async () => {
      callCount++;
      // Odd-numbered calls throw; even-numbered succeed
      if (callCount % 2 === 1) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("simulated NIM 500");
      }
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      } as unknown as Response;
    });

    const client = newClient();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => client.complete("sys", "user"))
    );
    expect(results.filter((r) => r.status === "rejected").length).toBe(4);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(4);
    // No deadlock — all 8 resolved (not hung)
  });
});
