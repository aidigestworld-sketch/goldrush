import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import PaymentSuccessView from "../components/PaymentSuccessView";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getCheckoutStatus: vi.fn() };
});

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() })),
  usePathname: () => "/vertical-request/success",
  useSearchParams: () => new URLSearchParams(),
  redirect: (url: string): never => { throw new Error(`REDIRECT:${url}`); },
}));

const { getCheckoutStatus } = await import("../lib/api");
const mockGetStatus = vi.mocked(getCheckoutStatus);

const { useRouter } = await import("next/navigation");
const mockUseRouter = vi.mocked(useRouter);

// ── Helpers ───────────────────────────────────────────────────────────────────

let pushMock: ReturnType<typeof vi.fn>;

function renderView(overrides: Partial<React.ComponentProps<typeof PaymentSuccessView>> = {}) {
  return render(
    <PaymentSuccessView
      founderId="founder-123"
      sessionId="cs_test_session_1"
      accessToken="test-token"
      pollIntervalMs={100}
      pollTimeoutMs={500}
      {...overrides}
    />
  );
}

// ── Real-timer tests ──────────────────────────────────────────────────────────
// These tests use real timers and waitFor because the polling happens fast
// enough (first response is immediate) that they complete well within timeout.

describe("PaymentSuccessView", () => {
  beforeEach(() => {
    pushMock = vi.fn();
    mockUseRouter.mockReturnValue({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() });
    vi.clearAllMocks();
    // Re-apply pushMock after clearAllMocks
    mockUseRouter.mockReturnValue({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() });
  });

  it("shows the confirming-payment loading state on mount", () => {
    mockGetStatus.mockResolvedValue({ paid: true, runId: null });
    renderView();
    expect(screen.getByTestId("confirming-payment")).toBeInTheDocument();
    expect(screen.getByText(/Confirming your payment/i)).toBeInTheDocument();
  });

  it("redirects to run status page immediately when first poll returns a runId", async () => {
    mockGetStatus.mockResolvedValueOnce({ paid: true, runId: "run-abc-123" });
    renderView();
    await waitFor(
      () => expect(pushMock).toHaveBeenCalledWith("/runs/run-abc-123"),
      { timeout: 500 }
    );
  });

  it("shows not-paid state when paid is false", async () => {
    mockGetStatus.mockResolvedValueOnce({ paid: false, runId: null });
    renderView();
    await waitFor(
      () => expect(screen.getByTestId("not-paid-state")).toBeInTheDocument(),
      { timeout: 500 }
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("polls with the correct founderId, sessionId, and accessToken", async () => {
    mockGetStatus.mockResolvedValueOnce({ paid: true, runId: "run-xyz" });
    renderView({ founderId: "founder-abc", sessionId: "cs_test_args" });
    await waitFor(
      () => expect(mockGetStatus).toHaveBeenCalledWith("founder-abc", "cs_test_args", "test-token"),
      { timeout: 500 }
    );
  });
});

// ── Fake-timer tests ──────────────────────────────────────────────────────────
// Uses vi.useFakeTimers() so we control each polling tick precisely.
// The same pattern as RunStatusView's polling-stop tests.

describe("PaymentSuccessView (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetStatus.mockReset();
    pushMock = vi.fn();
    mockUseRouter.mockReturnValue({ push: pushMock, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls again after interval and redirects when runId appears on second poll", async () => {
    mockGetStatus
      .mockResolvedValueOnce({ paid: true, runId: null })    // first poll
      .mockResolvedValueOnce({ paid: true, runId: "run-found" }); // second poll

    renderView({ pollIntervalMs: 100 });

    // Tick 1: first poll fires immediately — no timer needed, just flush microtasks
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(pushMock).not.toHaveBeenCalled();

    // Tick 2: setTimeout(poll, 100) fires at t=100ms
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(pushMock).toHaveBeenCalledWith("/runs/run-found");
  });

  it("shows timeout state after pollTimeoutMs elapses without a runId", async () => {
    mockGetStatus.mockResolvedValue({ paid: true, runId: null });

    // pollTimeoutMs=300 → times out after 3 scheduling cycles (0ms + 100ms + 100ms + 100ms)
    renderView({ pollIntervalMs: 100, pollTimeoutMs: 300 });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });   // t=0  elapsed=0   < 300
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // t=100 elapsed=100 < 300
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // t=200 elapsed=200 < 300
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // t=300 elapsed=300 >= 300 → timeout

    expect(screen.getByTestId("timeout-state")).toBeInTheDocument();
    expect(screen.getByTestId("refresh-button")).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("timeout state mentions payment when paid was confirmed before timeout", async () => {
    mockGetStatus.mockResolvedValue({ paid: true, runId: null });

    renderView({ pollIntervalMs: 100, pollTimeoutMs: 100 });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });   // poll 1: elapsed=0 < 100
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // poll 2: elapsed=100 >= 100 → timeout

    expect(screen.getByTestId("timeout-state")).toBeInTheDocument();
    // Since paid=true was returned, the message should reference the payment
    expect(screen.getByTestId("timeout-state")).toHaveTextContent(/payment/i);
  });

  it("stops polling after runId is found (no extra calls)", async () => {
    mockGetStatus
      .mockResolvedValueOnce({ paid: true, runId: null })
      .mockResolvedValueOnce({ paid: true, runId: "run-stop" });

    renderView({ pollIntervalMs: 100 });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // → redirect
    expect(mockGetStatus).toHaveBeenCalledTimes(2);

    // Advance further — no more polls should fire
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });
});
