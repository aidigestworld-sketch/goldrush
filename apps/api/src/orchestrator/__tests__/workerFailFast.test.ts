// Unit tests for the worker's NIM-504-one-retry policy.
//
// The full Worker class needs Redis + a BullMQ queue to run, so instead
// of standing that up we test the two pure helpers the worker delegates
// to: makeFailFastHandler (wraps the handler; conditionally promotes
// 504 to UnrecoverableError) and evaluateWorkerFailure (decides in
// on('failed') whether to mark the checkpoint failed_permanent on THIS
// attempt).
//
// The policy (post-2026-07-18 revision, driven by runDiscoveryReproTest.ts):
//   - A NIM gateway 504 gets exactly ONE retry, then failed_permanent.
//     Was previously fail-fast-on-first-504, on the assumption retrying
//     would just hammer an overloaded gateway. The isolated repro proved
//     each attempt is an independent draw against NIM's ~300s timeout —
//     one retry has ~75% cumulative success chance and is worth taking.
//   - Non-504 errors are unaffected: JSON parse failures, network glitches,
//     other NIM status codes (429, 500, 503) all keep their normal
//     3-attempt exponential backoff.
//
// End-to-end verification (real Worker + real Redis + real BullMQ)
// happens in reconciliation.test.ts which already exercises the
// dag_run_state <-> BullMQ state transitions.

import { describe, it, expect } from "vitest";
import { UnrecoverableError } from "bullmq";
import { makeFailFastHandler, evaluateWorkerFailure } from "../worker";

// BullMQ's MinimalJob has many required fields — the handler only reads
// attemptsMade, so a small stub works. `as any` scoped to test helpers.
function jobWith(attemptsMade: number): { attemptsMade: number } {
  return { attemptsMade };
}

describe("makeFailFastHandler — first 504 retries, second 504 becomes UnrecoverableError", () => {
  it("passes through the handler's return value on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await makeFailFastHandler(async () => "ok", jobWith(0) as any);
    expect(result).toBe("ok");
  });

  it("re-throws a NIM 504 UNWRAPPED on first attempt (attemptsMade=0) — BullMQ retries", async () => {
    const nim504 = new Error(
      "NIM API error (model=nvidia/llama-3.3-nemotron-super-49b-v1): 504 Gateway Timeout"
    );
    await expect(
      makeFailFastHandler(async () => {
        throw nim504;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, jobWith(0) as any)
    ).rejects.toBe(nim504);
  });

  it("promotes a NIM 504 to UnrecoverableError on retry (attemptsMade>=1)", async () => {
    const nim504 = new Error(
      "NIM API error (model=nvidia/llama-3.3-nemotron-super-49b-v1): 504 Gateway Timeout"
    );
    await expect(
      makeFailFastHandler(async () => {
        throw nim504;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, jobWith(1) as any)
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("preserves the original error message on the promoted UnrecoverableError", async () => {
    const nim504 = new Error("NIM API error (model=x): 504 upstream unavailable");
    let caught: unknown;
    try {
      await makeFailFastHandler(async () => {
        throw nim504;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, jobWith(1) as any);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain("NIM API error");
    expect((caught as Error).message).toContain("504");
  });

  it("attaches the original error as .cause so formatErrorForStorage keeps context", async () => {
    const nim504 = new Error("NIM API error (model=x): 504 upstream unavailable");
    let caught: Error & { cause?: unknown } = new Error("uninit");
    try {
      await makeFailFastHandler(async () => {
        throw nim504;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, jobWith(1) as any);
    } catch (err) {
      caught = err as Error & { cause?: unknown };
    }
    expect(caught.cause).toBe(nim504);
  });

  it("re-throws non-504 errors UNWRAPPED regardless of attempt (BullMQ retries normally)", async () => {
    const jsonErr = new Error("Unexpected end of JSON input");
    for (const attempt of [0, 1, 2]) {
      await expect(
        makeFailFastHandler(async () => {
          throw jsonErr;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, jobWith(attempt) as any)
      ).rejects.toBe(jsonErr);
    }
  });

  it("re-throws network errors UNWRAPPED (transient, keep retries)", async () => {
    const netErr = new Error("fetch failed");
    (netErr as unknown as { code: string }).code = "ECONNRESET";
    await expect(
      makeFailFastHandler(async () => {
        throw netErr;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }, jobWith(0) as any)
    ).rejects.toBe(netErr);
  });

  it("re-throws NIM non-504 status codes UNWRAPPED (429, 500, 503 keep retries)", async () => {
    for (const status of [429, 500, 503]) {
      const err = new Error(`NIM API error (model=x): ${status} something`);
      await expect(
        makeFailFastHandler(async () => {
          throw err;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }, jobWith(1) as any)
      ).rejects.toBe(err);
    }
  });

  it("treats missing job (null) as first attempt — allows one 504 pass-through", async () => {
    // Defense-in-depth: if a caller ever invokes makeFailFastHandler
    // without a job (only worker.on runs it in prod, but tests/probes
    // might), don't accidentally wrap on the first pass.
    const nim504 = new Error("NIM API error (model=x): 504");
    await expect(
      makeFailFastHandler(async () => {
        throw nim504;
      }, null)
    ).rejects.toBe(nim504);
  });
});

describe("evaluateWorkerFailure — decides markPermanent on the failed hook", () => {
  it("normal error, attempt 1/3 → markPermanent=false, failFast=false (keep retrying)", () => {
    const decision = evaluateWorkerFailure({
      attemptsMade: 1,
      attemptsLimit: 3,
      err: new Error("fetch failed"),
    });
    expect(decision).toEqual({ markPermanent: false, failFast: false });
  });

  it("normal error, attempt 3/3 → markPermanent=true (exhaustion), failFast=false", () => {
    const decision = evaluateWorkerFailure({
      attemptsMade: 3,
      attemptsLimit: 3,
      err: new Error("Unexpected end of JSON input"),
    });
    expect(decision).toEqual({ markPermanent: true, failFast: false });
  });

  it("raw NIM 504 on attempt 1/3 → markPermanent=false (allow one retry)", () => {
    // Policy change: was permanent under the old fail-fast policy. The
    // runDiscoveryReproTest.ts data justified allowing one retry.
    const decision = evaluateWorkerFailure({
      attemptsMade: 1,
      attemptsLimit: 3,
      err: new Error("NIM API error (model=x): 504 Gateway Timeout"),
    });
    expect(decision).toEqual({ markPermanent: false, failFast: false });
  });

  it("raw NIM 504 on attempt 2/3 → markPermanent=true (second consecutive 504, cap here)", () => {
    // The critical new-policy cap: makeFailFastHandler should have wrapped
    // this as UnrecoverableError already, but as defense-in-depth we
    // still cap here when the raw 504 leaks past the wrapper.
    const decision = evaluateWorkerFailure({
      attemptsMade: 2,
      attemptsLimit: 3,
      err: new Error("NIM API error (model=x): 504 Gateway Timeout"),
    });
    expect(decision).toEqual({ markPermanent: true, failFast: true });
  });

  it("UnrecoverableError on attempt 1 → markPermanent=true, failFast=true", () => {
    // If any code raises UnrecoverableError (e.g., a future non-504
    // fail-fast class), respect it immediately.
    const decision = evaluateWorkerFailure({
      attemptsMade: 1,
      attemptsLimit: 3,
      err: new UnrecoverableError("NIM API error (model=x): 504 timeout"),
    });
    expect(decision).toEqual({ markPermanent: true, failFast: true });
  });

  it("NIM 500 on attempt 1/3 → markPermanent=false (retry it normally)", () => {
    // 500 is upstream trouble but not the specific overload signature
    // 504 is. Keep the normal retry budget — a transient 500 may
    // recover on the next attempt.
    const decision = evaluateWorkerFailure({
      attemptsMade: 1,
      attemptsLimit: 3,
      err: new Error("NIM API error (model=x): 500 Internal Server Error"),
    });
    expect(decision).toEqual({ markPermanent: false, failFast: false });
  });

  it("NIM 504 nested inside .cause on attempt 2/3 → markPermanent=true", () => {
    // BullMQ may wrap the underlying error. The detector must walk
    // .cause. Still second-consecutive on attempt 2 → cap here.
    const inner = new Error("NIM API error (model=x): 504");
    const outer = new Error("worker crashed");
    (outer as unknown as { cause: Error }).cause = inner;
    const decision = evaluateWorkerFailure({
      attemptsMade: 2,
      attemptsLimit: 3,
      err: outer,
    });
    expect(decision).toEqual({ markPermanent: true, failFast: true });
  });

  it("NIM 504 nested inside .cause on attempt 1/3 → markPermanent=false (allow one retry)", () => {
    // Same as the top-level 504-on-attempt-1 case — .cause walking
    // shouldn't accidentally re-enable the old fail-fast policy.
    const inner = new Error("NIM API error (model=x): 504");
    const outer = new Error("worker crashed");
    (outer as unknown as { cause: Error }).cause = inner;
    const decision = evaluateWorkerFailure({
      attemptsMade: 1,
      attemptsLimit: 3,
      err: outer,
    });
    expect(decision).toEqual({ markPermanent: false, failFast: false });
  });
});
