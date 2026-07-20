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

  // ── "Start a new analysis" button (populated state only) ─────────────────
  // Regression guard for the 2026-07-16 gap: once a founder had ≥1 run,
  // the dashboard offered NO visible path to start another (only the
  // empty-state CTA existed, and it was hidden as soon as any run
  // appeared). Fix places a primary button in the populated-branch
  // header, linking to /vertical-request. Pin the button's presence,
  // href, and label so a future refactor can't silently re-hide it.

  it("populated state: shows 'Start a new analysis' button linking to /vertical-request", () => {
    render(<DashboardList runs={[makeRun({ runId: "ok1" })]} />);
    const btn = screen.getByTestId("new-analysis-button");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/start a new analysis/i);
    // Linked directly to /vertical-request — skips /intake because the
    // returning founder already has a completed profile. If profile
    // updates are ever needed, that becomes a separate flow.
    expect(btn.getAttribute("href")).toBe("/vertical-request");
  });

  it("empty state: does NOT show the header-level 'Start a new analysis' button (EmptyState renders its own primary CTA)", () => {
    render(<DashboardList runs={[]} />);
    // The empty-state CTA (linking to /intake for fresh founders) is
    // still there; the header button is deliberately absent to avoid
    // two competing primary CTAs on the same view.
    expect(screen.queryByTestId("new-analysis-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("empty-state-cta")).toBeInTheDocument();
  });

  it("button is visible regardless of run status (queued/in_progress/completed/failed)", () => {
    // Any mix of runs should still expose the button — the whole point
    // is that a founder is never trapped without a way to start another.
    const runs = [
      makeRun({ runId: "q", overall: "queued" }),
      makeRun({ runId: "p", overall: "in_progress" }),
      makeRun({ runId: "c", overall: "completed" }),
      makeRun({ runId: "f", overall: "failed" }),
    ];
    render(<DashboardList runs={runs} />);
    expect(screen.getByTestId("new-analysis-button")).toBeInTheDocument();
  });
});
