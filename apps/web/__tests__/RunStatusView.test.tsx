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

// Mock the API module so polling never hits the network.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getRunStatus: vi.fn() };
});

// Import the mock AFTER vi.mock so we get the mocked version.
const { getRunStatus } = await import("../lib/api");
const mockGetRunStatus = vi.mocked(getRunStatus);

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

  it("polls when overall is in_progress", async () => {
    mockGetRunStatus.mockResolvedValue(IN_PROGRESS);
    render(
      <RunStatusView runId="r1" initialData={IN_PROGRESS} pollIntervalMs={20} />
    );
    await waitFor(
      () => expect(mockGetRunStatus).toHaveBeenCalledWith("r1"),
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
