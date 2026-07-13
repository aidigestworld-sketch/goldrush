import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import DashboardList from "../components/DashboardList";
import type { FounderRun } from "../lib/api";

const FIXED_NOW = new Date("2025-08-01T12:00:00Z").getTime();
beforeAll(() => vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW));
afterAll(() => vi.restoreAllMocks());

function makeRun(overrides: Partial<FounderRun> = {}): FounderRun {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    vertical: "shopify_subscriptions",
    createdAt: new Date(FIXED_NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
    overall: "in_progress",
    opportunity: null,
    ...overrides,
  };
}

describe("DashboardList", () => {
  // ── Empty state ──────────────────────────────────────────────────────────

  it("renders empty state when runs array is empty", () => {
    render(<DashboardList runs={[]} />);
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("shows heading even in empty state", () => {
    render(<DashboardList runs={[]} />);
    expect(screen.getByRole("heading", { name: /your analyses/i })).toBeInTheDocument();
  });

  it("empty state has a call-to-action link", () => {
    render(<DashboardList runs={[]} />);
    const cta = screen.getByTestId("empty-state-cta");
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveTextContent(/start an analysis/i);
    // CTA links to /intake (stub destination until chat-intake is built)
    expect(cta.getAttribute("href")).toBe("/intake");
  });

  it("does not render the run list when empty", () => {
    render(<DashboardList runs={[]} />);
    expect(screen.queryByTestId("run-list")).not.toBeInTheDocument();
  });

  // ── Populated list ───────────────────────────────────────────────────────

  it("renders a card for each run", () => {
    const runs = [makeRun({ runId: "aaa" }), makeRun({ runId: "bbb" }), makeRun({ runId: "ccc" })];
    render(<DashboardList runs={runs} />);
    expect(screen.getByTestId("run-list")).toBeInTheDocument();
    expect(screen.getByTestId("run-card-aaa")).toBeInTheDocument();
    expect(screen.getByTestId("run-card-bbb")).toBeInTheDocument();
    expect(screen.getByTestId("run-card-ccc")).toBeInTheDocument();
  });

  it("does not render empty state when runs are present", () => {
    render(<DashboardList runs={[makeRun()]} />);
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
  });

  it("renders heading", () => {
    render(<DashboardList runs={[makeRun()]} />);
    expect(screen.getByRole("heading", { name: /your analyses/i })).toBeInTheDocument();
  });

  // ── Status badge variants in the list ────────────────────────────────────

  it("renders queued badge", () => {
    render(<DashboardList runs={[makeRun({ overall: "queued", runId: "q1" })]} />);
    expect(screen.getByTestId("status-badge-queued")).toBeInTheDocument();
  });

  it("renders in_progress badge", () => {
    render(<DashboardList runs={[makeRun({ overall: "in_progress", runId: "ip1" })]} />);
    expect(screen.getByTestId("status-badge-in_progress")).toBeInTheDocument();
  });

  it("renders completed badge", () => {
    render(<DashboardList runs={[makeRun({ overall: "completed", runId: "c1" })]} />);
    expect(screen.getByTestId("status-badge-completed")).toBeInTheDocument();
  });

  it("renders failed badge", () => {
    render(<DashboardList runs={[makeRun({ overall: "failed", runId: "f1" })]} />);
    expect(screen.getByTestId("status-badge-failed")).toBeInTheDocument();
  });

  // ── Completed run with opportunity data ──────────────────────────────────

  it("renders headline for completed run with opportunity", () => {
    const run = makeRun({
      runId: "comp1",
      overall: "completed",
      opportunity: {
        ventureScore: 0.9,
        confidenceScore: 0.8,
        founderFitScore: 0.75,
        headline: "Defensible niche with low existing solutions",
      },
    });
    render(<DashboardList runs={[run]} />);
    expect(screen.getByTestId("run-card-headline")).toHaveTextContent(
      "Defensible niche with low existing solutions"
    );
  });

  it("renders score chips for completed run with opportunity", () => {
    const run = makeRun({
      runId: "comp2",
      overall: "completed",
      opportunity: {
        ventureScore: 0.88,
        confidenceScore: 0.72,
        founderFitScore: 0.61,
        headline: "Some headline",
      },
    });
    render(<DashboardList runs={[run]} />);
    expect(screen.getByTestId("run-card-scores")).toBeInTheDocument();
    expect(screen.getByTestId("score-chip-venture")).toHaveTextContent("88");
    expect(screen.getByTestId("score-chip-confidence")).toHaveTextContent("72");
    expect(screen.getByTestId("score-chip-fit")).toHaveTextContent("61");
  });

  it("does not render scores for non-completed runs", () => {
    const run = makeRun({ overall: "in_progress", opportunity: null });
    render(<DashboardList runs={[run]} />);
    expect(screen.queryByTestId("run-card-scores")).not.toBeInTheDocument();
  });
});
