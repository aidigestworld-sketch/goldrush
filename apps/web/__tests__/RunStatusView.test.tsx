import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import RunStatusView from "../components/RunStatusView";
import type { RunStatus, StepInfo, Stage } from "../lib/api";

// Mock the API module so polling and retry never hit the network.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getRunStatus: vi.fn(), retryRun: vi.fn() };
});

// Import the mocks AFTER vi.mock so we get the mocked versions.
const { getRunStatus, retryRun } = await import("../lib/api");
const mockGetRunStatus = vi.mocked(getRunStatus);
const mockRetryRun = vi.mocked(retryRun);

// ── Fixture builders ──────────────────────────────────────────────────────

function makeStep(
  step: string,
  label: string,
  overrides: Partial<StepInfo> = {}
): StepInfo {
  return {
    step,
    label,
    status: "not_started",
    attemptCount: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

const STEP_STAGES: Stage[] = [
  { type: "step", ...makeStep("discovery", "Discovery", { status: "succeeded", startedAt: "2025-08-01T10:00:00Z", completedAt: "2025-08-01T10:00:03Z" }) },
  { type: "step", ...makeStep("expansion", "Expansion", { status: "succeeded", startedAt: "2025-08-01T10:00:03Z", completedAt: "2025-08-01T10:00:07Z" }) },
  { type: "step", ...makeStep("filtering", "Filtering", { status: "running", startedAt: "2025-08-01T10:00:07Z" }) },
  { type: "step", ...makeStep("competitive_analysis", "Competitive Analysis") },
  { type: "step", ...makeStep("hypothesis", "Hypothesis Generation") },
  { type: "step", ...makeStep("validation", "Validation") },
  { type: "step", ...makeStep("confidence_mode1", "Confidence (Mode 1)") },
  { type: "step", ...makeStep("composition", "Composition") },
  { type: "step", ...makeStep("scoring", "Scoring") },
  {
    type: "fork",
    branches: [
      makeStep("confidence_mode2", "Confidence (Mode 2)"),
      makeStep("founder_fit", "Founder Fit"),
    ],
  },
  { type: "step", ...makeStep("compression", "Compression") },
];

function makeStatus(
  overall: RunStatus["run"]["overall"],
  stages: Stage[] = STEP_STAGES
): RunStatus {
  return {
    run: {
      runId: "run-test-1",
      hypothesisId: null,
      vertical: "shopify_subscriptions",
      startedAt: "2025-08-01T10:00:00Z",
      overall,
    },
    stages,
  };
}

const IN_PROGRESS = makeStatus("in_progress");
const COMPLETED = makeStatus("completed", [
  ...STEP_STAGES.slice(0, -1).map((s) =>
    s.type === "step"
      ? { ...s, status: "succeeded" as const }
      : {
          ...s,
          branches: s.branches.map((b) => ({ ...b, status: "succeeded" as const })),
        }
  ),
  { type: "step", ...makeStep("compression", "Compression", { status: "succeeded" }) },
]);

// Empty-cascade terminal state: every step succeeded (Discovery skipped
// for lack of evidence, then the whole chain no-oped) but Compression's
// terminalCommit wrote pipeline_run.status='insufficient_evidence'. The
// derivation surfaces that here so the badge / result link / polling all
// treat this as terminal, not "Completed".
const INSUFFICIENT_EVIDENCE = makeStatus("insufficient_evidence", [
  ...STEP_STAGES.slice(0, -1).map((s) =>
    s.type === "step"
      ? { ...s, status: "succeeded" as const }
      : {
          ...s,
          branches: s.branches.map((b) => ({ ...b, status: "succeeded" as const })),
        }
  ),
  { type: "step", ...makeStep("compression", "Compression", { status: "succeeded" }) },
]);

const WITH_FAILURE = makeStatus("failed", [
  { type: "step", ...makeStep("discovery", "Discovery", { status: "succeeded" }) },
  {
    type: "step",
    ...makeStep("expansion", "Expansion", {
      status: "failed_permanent",
      lastError: "LLM returned invalid JSON after 3 attempts",
    }),
  },
  ...STEP_STAGES.slice(2),
]);

const WITH_LONG_ERROR = makeStatus("failed", [
  {
    type: "step",
    ...makeStep("discovery", "Discovery", {
      status: "failed_permanent",
      lastError: "A".repeat(200), // longer than ERROR_TRUNCATE (120)
    }),
  },
  ...STEP_STAGES.slice(1),
]);

// ── Tests ─────────────────────────────────────────────────────────────────

describe("RunStatusView", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Stage list shape ─────────────────────────────────────────────────────

  it("renders stage rows for each linear step", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByTestId("stage-row-discovery")).toBeInTheDocument();
    expect(screen.getByTestId("stage-row-filtering")).toBeInTheDocument();
    expect(screen.getByTestId("stage-row-compression")).toBeInTheDocument();
  });

  it("renders human-readable labels for steps", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByText("Competitive Analysis")).toBeInTheDocument();
    expect(screen.getByText("Hypothesis Generation")).toBeInTheDocument();
  });

  it("shows the correct status icon for each status variant", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    // discovery AND expansion are both succeeded → use getAllByTestId
    expect(screen.getAllByTestId("icon-succeeded").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("icon-running")).toBeInTheDocument(); // filtering
    expect(screen.getAllByTestId("icon-not_started").length).toBeGreaterThan(0);
  });

  it("shows duration for steps with both startedAt and completedAt", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    // discovery: 3.0s, expansion: 4.0s
    expect(screen.getByText("3.0s")).toBeInTheDocument();
    expect(screen.getByText("4.0s")).toBeInTheDocument();
  });

  it("shows 'running…' label for a running step", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByText("running…")).toBeInTheDocument();
  });

  it("shows 'queued' label for pending steps", () => {
    const withPending = makeStatus("in_progress", [
      {
        type: "step",
        ...makeStep("discovery", "Discovery", { status: "pending" }),
      },
      ...STEP_STAGES.slice(1),
    ]);
    render(<RunStatusView runId="r1" initialData={withPending} />);
    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  it("renders the overall status badge", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByTestId("status-badge-in_progress")).toBeInTheDocument();
  });

  it("renders the vertical name formatted as title case", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByText("Shopify Subscriptions")).toBeInTheDocument();
  });

  // ── Fork stage ───────────────────────────────────────────────────────────

  it("renders the fork stage container", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByTestId("fork-stage")).toBeInTheDocument();
  });

  it("renders both fork branches", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByTestId("fork-branch-confidence_mode2")).toBeInTheDocument();
    expect(screen.getByTestId("fork-branch-founder_fit")).toBeInTheDocument();
  });

  it("fork branches have their own stage rows", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByTestId("stage-row-confidence_mode2")).toBeInTheDocument();
    expect(screen.getByTestId("stage-row-founder_fit")).toBeInTheDocument();
  });

  it("shows branch labels inside the fork", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.getByText("Confidence (Mode 2)")).toBeInTheDocument();
    expect(screen.getByText("Founder Fit")).toBeInTheDocument();
  });

  // ── Failure detail ───────────────────────────────────────────────────────

  it("shows error message inline for failed_permanent step", () => {
    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);
    expect(screen.getByTestId("stage-error-expansion")).toBeInTheDocument();
    expect(screen.getByTestId("stage-error-expansion")).toHaveTextContent(
      "LLM returned invalid JSON after 3 attempts"
    );
  });

  it("renders failed_permanent icon for failed step", () => {
    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);
    expect(screen.getByTestId("icon-failed_permanent")).toBeInTheDocument();
  });

  it("truncates long errors and shows 'Show full error' toggle", () => {
    render(<RunStatusView runId="r1" initialData={WITH_LONG_ERROR} />);
    expect(screen.getByText("Show full error")).toBeInTheDocument();
    // Only 120 chars visible + ellipsis — full 200-char string should not appear
    const errorBox = screen.getByTestId("stage-error-discovery");
    expect(errorBox.textContent?.length).toBeLessThan(200);
  });

  it("expands long error when toggle is clicked", () => {
    render(<RunStatusView runId="r1" initialData={WITH_LONG_ERROR} />);
    fireEvent.click(screen.getByText("Show full error"));
    expect(screen.getByText("Show less")).toBeInTheDocument();
    const errorBox = screen.getByTestId("stage-error-discovery");
    // Full 200-char string is now visible
    expect(errorBox.textContent).toContain("A".repeat(200));
  });

  it("does not render error box for non-failed steps", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.queryByTestId("stage-error-discovery")).not.toBeInTheDocument();
  });

  // ── Completed run navigation ─────────────────────────────────────────────

  it("shows 'View Results' link when overall is completed", () => {
    render(<RunStatusView runId="run-test-1" initialData={COMPLETED} />);
    const link = screen.getByTestId("result-link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent("View Results");
    expect(link.getAttribute("href")).toBe("/runs/run-test-1/result");
  });

  it("does not show 'View Results' link when in_progress", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.queryByTestId("result-link")).not.toBeInTheDocument();
  });

  it("does not show 'View Results' link when failed", () => {
    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);
    expect(screen.queryByTestId("result-link")).not.toBeInTheDocument();
  });

  it("shows 'View Results' link when overall is insufficient_evidence", () => {
    // The result page renders "no opportunity cleared the bar" / "no
    // candidates ever composed" for these runs — so the link IS surfaced
    // (unlike 'failed', which has nothing scored to show).
    render(<RunStatusView runId="run-test-1" initialData={INSUFFICIENT_EVIDENCE} />);
    expect(screen.getByTestId("result-link")).toBeInTheDocument();
  });

  it("renders the Insufficient Evidence badge (distinct from Completed)", () => {
    render(<RunStatusView runId="r1" initialData={INSUFFICIENT_EVIDENCE} />);
    expect(screen.getByTestId("status-badge-insufficient_evidence")).toBeInTheDocument();
    expect(screen.queryByTestId("status-badge-completed")).not.toBeInTheDocument();
  });

  // ── Polling behaviour ────────────────────────────────────────────────────

  it("does not poll when initial state is already completed", async () => {
    render(
      <RunStatusView runId="r1" initialData={COMPLETED} pollIntervalMs={10} />
    );
    // Wait long enough that polling would have fired if active
    await new Promise((r) => setTimeout(r, 60));
    expect(mockGetRunStatus).not.toHaveBeenCalled();
  });

  it("does not poll when initial state is failed", async () => {
    render(
      <RunStatusView runId="r1" initialData={WITH_FAILURE} pollIntervalMs={10} />
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(mockGetRunStatus).not.toHaveBeenCalled();
  });

  it("does not poll when initial state is insufficient_evidence (terminal)", async () => {
    render(
      <RunStatusView runId="r1" initialData={INSUFFICIENT_EVIDENCE} pollIntervalMs={10} />
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(mockGetRunStatus).not.toHaveBeenCalled();
  });

  it("polls when overall is in_progress, forwarding accessToken", async () => {
    mockGetRunStatus.mockResolvedValue(IN_PROGRESS);
    render(
      <RunStatusView
        runId="r1"
        initialData={IN_PROGRESS}
        accessToken="poll-token"
        pollIntervalMs={20}
      />
    );
    // Same regression as the retry test: pass BOTH args explicitly.
    // Without the accessToken forward, the poll silently 401'd every
    // tick and looked identical to "still processing" on screen.
    await waitFor(
      () => expect(mockGetRunStatus).toHaveBeenCalledWith("r1", "poll-token"),
      { timeout: 200 }
    );
  });

  it("polls when overall is queued", async () => {
    const queued = makeStatus("queued");
    mockGetRunStatus.mockResolvedValue(queued);
    render(
      <RunStatusView runId="r1" initialData={queued} pollIntervalMs={20} />
    );
    await waitFor(
      () => expect(mockGetRunStatus).toHaveBeenCalled(),
      { timeout: 200 }
    );
  });

  it("shows View Results after polling transitions to completed", async () => {
    mockGetRunStatus.mockResolvedValueOnce(COMPLETED);

    render(
      <RunStatusView runId="run-test-1" initialData={IN_PROGRESS} pollIntervalMs={20} />
    );

    // Initially no result link
    expect(screen.queryByTestId("result-link")).not.toBeInTheDocument();

    // After poll updates state to completed, result link appears
    await waitFor(
      () => expect(screen.getByTestId("result-link")).toBeInTheDocument(),
      { timeout: 300 }
    );
  });
});

  // ── Retry button ──────────────────────────────────────────────────────────

describe("RunStatusView retry button", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("shows retry button only when overall is failed", () => {
    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);
    expect(screen.getByTestId("retry-button")).toBeInTheDocument();
  });

  it("does not show retry button when in_progress", () => {
    render(<RunStatusView runId="r1" initialData={IN_PROGRESS} />);
    expect(screen.queryByTestId("retry-button")).not.toBeInTheDocument();
  });

  it("does not show retry button when completed", () => {
    render(<RunStatusView runId="run-test-1" initialData={COMPLETED} />);
    expect(screen.queryByTestId("retry-button")).not.toBeInTheDocument();
  });

  it("clicking retry calls retryRun then getRunStatus WITH the access token and transitions back to in_progress", async () => {
    mockRetryRun.mockResolvedValueOnce({ runId: "r1", retried: ["expansion"] });
    mockGetRunStatus.mockResolvedValueOnce(IN_PROGRESS);

    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} accessToken="test-token" />);
    fireEvent.click(screen.getByTestId("retry-button"));

    await waitFor(() => {
      expect(mockRetryRun).toHaveBeenCalledWith("r1", "test-token");
    });
    // Regression for the 2026-07-16 bug: the follow-up status fetch
    // used to omit accessToken, producing a 401 "GET /runs/:id/status
    // failed with status 401" as the retry-error banner. Assert BOTH
    // args explicitly so anyone regressing the fix trips this test.
    await waitFor(() => {
      expect(mockGetRunStatus).toHaveBeenCalledWith("r1", "test-token");
    });
    // After transition the retry button disappears (overall is in_progress now)
    await waitFor(() => {
      expect(screen.queryByTestId("retry-button")).not.toBeInTheDocument();
    });
  });

  it("retry button is disabled and shows 'Retrying…' while the call is in flight", async () => {
    let resolveRetry!: (v: { runId: string; retried: string[] }) => void;
    mockRetryRun.mockReturnValueOnce(
      new Promise<{ runId: string; retried: string[] }>((r) => { resolveRetry = r; })
    );

    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);
    fireEvent.click(screen.getByTestId("retry-button"));

    expect(screen.getByTestId("retry-button")).toHaveTextContent("Retrying…");
    expect(screen.getByTestId("retry-button")).toBeDisabled();

    // Clean up dangling promise
    mockGetRunStatus.mockResolvedValueOnce(IN_PROGRESS);
    resolveRetry({ runId: "r1", retried: ["expansion"] });
  });

  it("shows retry error when retryRun throws", async () => {
    mockRetryRun.mockRejectedValueOnce(new Error("server error"));

    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);
    fireEvent.click(screen.getByTestId("retry-button"));

    await waitFor(() => {
      expect(screen.getByTestId("retry-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("retry-error")).toHaveTextContent("server error");
    // Button is re-enabled after error
    expect(screen.getByTestId("retry-button")).not.toBeDisabled();
  });

  it("clears stale retry error banner when overall status changes (second retry succeeds)", async () => {
    // The useEffect on data.run.overall resets retryState/retryError whenever
    // overall changes — so a stale error from a previous failed retry attempt
    // disappears as soon as the run's status transitions.
    // Here: first retry fails → error banner shows; second retry succeeds →
    // setData(IN_PROGRESS) changes overall → useEffect clears the banner.
    mockRetryRun
      .mockRejectedValueOnce(new Error("cannot retry: run status is 'running'"))
      .mockResolvedValueOnce({ runId: "r1", retried: ["expansion"] });
    mockGetRunStatus.mockResolvedValueOnce(IN_PROGRESS);

    render(<RunStatusView runId="r1" initialData={WITH_FAILURE} />);

    // First click: error
    fireEvent.click(screen.getByTestId("retry-button"));
    await waitFor(() => expect(screen.getByTestId("retry-error")).toBeInTheDocument());

    // Second click: success → setData(IN_PROGRESS) → overall "failed"→"in_progress" → banner clears
    fireEvent.click(screen.getByTestId("retry-button"));
    await waitFor(() => expect(screen.queryByTestId("retry-error")).not.toBeInTheDocument());
  });
});

// ── Polling stop tests (fake timers) ─────────────────────────────────────
// These tests use vi.useFakeTimers() so we control exactly when each
// interval tick fires and can flush React state updates with act() between
// ticks — avoids the race condition where the real interval fires again
// before React has processed the previous setData() call.
describe("RunStatusView polling stops at terminal state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetRunStatus.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops polling after transitioning to completed", async () => {
    mockGetRunStatus
      .mockResolvedValueOnce(IN_PROGRESS) // tick 1 → still running
      .mockResolvedValueOnce(COMPLETED);  // tick 2 → terminal

    render(
      <RunStatusView runId="r1" initialData={IN_PROGRESS} pollIntervalMs={1000} />
    );

    // Tick 1: fires at t=1000ms, gets IN_PROGRESS (same overall → effect stays)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockGetRunStatus).toHaveBeenCalledTimes(1);

    // Tick 2: fires at t=2000ms, gets COMPLETED → setData → effect cleans up
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockGetRunStatus).toHaveBeenCalledTimes(2);

    // Advance 5 more seconds — interval was cleared, no new calls
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockGetRunStatus).toHaveBeenCalledTimes(2);
  });

  it("stops polling after transitioning to failed", async () => {
    mockGetRunStatus
      .mockResolvedValueOnce(IN_PROGRESS)
      .mockResolvedValueOnce(WITH_FAILURE);

    render(
      <RunStatusView runId="r1" initialData={IN_PROGRESS} pollIntervalMs={1000} />
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mockGetRunStatus).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mockGetRunStatus).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockGetRunStatus).toHaveBeenCalledTimes(2);
  });

  // Suppress the React act() warning that appears because interval callbacks
  // update state outside of an explicit act() wrapper (the real-timer polling
  // tests above use waitFor, which handles this; fake-timer tests use act()
  // explicitly). These warnings are expected and don't affect correctness.
});

// ── Poll error visibility ────────────────────────────────────────────────
// Regression for the silent-catch bug: prior to the 2026-07-16 fix the
// poll interval swallowed every error with `catch {}`, so a persistent
// 401 (from the missing-accessToken bug) was invisible in devtools and
// indistinguishable from "still processing" on screen.
describe("RunStatusView poll error surfacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetRunStatus.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs to console.error when a poll fetch fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetRunStatus.mockRejectedValueOnce(new Error("Network Error"));

    render(
      <RunStatusView runId="r1" initialData={IN_PROGRESS} pollIntervalMs={1000} />
    );

    // Advance one tick — the poll fires, rejects, catch branch runs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The log fired, the error object is captured, and the last-known
    // state is still on screen (transient errors don't crash the view).
    expect(errSpy).toHaveBeenCalled();
    const loggedArgs = errSpy.mock.calls.at(-1)!;
    expect(String(loggedArgs[0])).toContain("[RunStatusView] poll failed");
    expect(String(loggedArgs[0])).toContain("r1");
    expect(screen.getByTestId("stage-list")).toBeInTheDocument();

    errSpy.mockRestore();
  });

  it("does NOT show the poll-failure indicator on a single hiccup", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetRunStatus
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(IN_PROGRESS);

    render(
      <RunStatusView runId="r1" initialData={IN_PROGRESS} pollIntervalMs={1000} />
    );

    // First tick: fails, count=1 — under threshold, no indicator.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId("poll-failure-indicator")).not.toBeInTheDocument();

    // Second tick: succeeds, count resets.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId("poll-failure-indicator")).not.toBeInTheDocument();

    errSpy.mockRestore();
  });

  it("surfaces the poll-failure indicator after 3 consecutive failures, hides it on next success", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetRunStatus
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockRejectedValueOnce(new Error("fail-3"))
      .mockResolvedValueOnce(IN_PROGRESS);

    render(
      <RunStatusView runId="r1" initialData={IN_PROGRESS} pollIntervalMs={1000} />
    );

    // Tick 1 & 2: under threshold — indicator absent.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId("poll-failure-indicator")).not.toBeInTheDocument();

    // Tick 3: crosses threshold — indicator appears.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByTestId("poll-failure-indicator")).toBeInTheDocument();

    // Tick 4: recovery — indicator disappears (count reset on success).
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByTestId("poll-failure-indicator")).not.toBeInTheDocument();

    errSpy.mockRestore();
  });
});

// ── formatDuration unit tests ─────────────────────────────────────────────

import { formatDuration } from "../components/StageRow";

describe("formatDuration", () => {
  const base = "2025-08-01T10:00:00.000Z";

  it("formats milliseconds", () => {
    const end = new Date(new Date(base).getTime() + 500).toISOString();
    expect(formatDuration(base, end)).toBe("500ms");
  });

  it("formats seconds with one decimal", () => {
    const end = new Date(new Date(base).getTime() + 3200).toISOString();
    expect(formatDuration(base, end)).toBe("3.2s");
  });

  it("formats minutes and seconds", () => {
    const end = new Date(new Date(base).getTime() + 192_000).toISOString();
    expect(formatDuration(base, end)).toBe("3m 12s");
  });
});
