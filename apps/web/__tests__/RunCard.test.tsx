import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RunCard, { formatRelativeTime, formatVertical } from "../components/RunCard";
import type { FounderRun } from "../lib/api";

// Pin Date.now() so relative-time assertions are deterministic.
const FIXED_NOW = new Date("2025-08-01T12:00:00Z").getTime();
beforeAll(() => vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW));
afterAll(() => vi.restoreAllMocks());

const BASE_RUN: FounderRun = {
  runId: "run-abc123",
  vertical: "shopify_subscriptions",
  createdAt: new Date(FIXED_NOW - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
  overall: "in_progress",
  opportunity: null,
};

const COMPLETED_RUN: FounderRun = {
  ...BASE_RUN,
  runId: "run-def456",
  overall: "completed",
  opportunity: {
    ventureScore: 0.82,
    confidenceScore: 0.71,
    founderFitScore: 0.65,
    headline: "Strong market pull in underserved segment",
  },
};

// ── Unit: helper functions ─────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  it("formats days ago", () => {
    const ts = new Date(FIXED_NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe("3 days ago");
  });

  it("uses singular for 1 day", () => {
    const ts = new Date(FIXED_NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe("1 day ago");
  });

  it("formats hours ago", () => {
    const ts = new Date(FIXED_NOW - 5 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe("5 hours ago");
  });

  it("formats minutes ago", () => {
    const ts = new Date(FIXED_NOW - 20 * 60 * 1000).toISOString();
    expect(formatRelativeTime(ts)).toBe("20 minutes ago");
  });

  it('returns "just now" for very recent', () => {
    const ts = new Date(FIXED_NOW - 5000).toISOString();
    expect(formatRelativeTime(ts)).toBe("just now");
  });
});

describe("formatVertical", () => {
  it("converts snake_case to Title Case", () => {
    expect(formatVertical("shopify_subscriptions")).toBe("Shopify Subscriptions");
  });

  it("handles multi-word verticals", () => {
    expect(formatVertical("b2b_customer_support_saas")).toBe("B2b Customer Support Saas");
  });
});

// ── Component rendering ────────────────────────────────────────────────────

describe("RunCard", () => {
  it("renders vertical name formatted as title case", () => {
    render(<RunCard run={BASE_RUN} />);
    expect(screen.getByText("Shopify Subscriptions")).toBeInTheDocument();
  });

  it("renders relative time", () => {
    render(<RunCard run={BASE_RUN} />);
    expect(screen.getByText("3 days ago")).toBeInTheDocument();
  });

  it("links in-progress run to /runs/:id (status view)", () => {
    render(<RunCard run={BASE_RUN} />);
    const link = screen.getByTestId(`run-card-${BASE_RUN.runId}`);
    expect(link.getAttribute("href")).toBe(`/runs/${BASE_RUN.runId}`);
  });

  it("links completed run to /runs/:id/result (result page)", () => {
    render(<RunCard run={COMPLETED_RUN} />);
    const link = screen.getByTestId(`run-card-${COMPLETED_RUN.runId}`);
    expect(link.getAttribute("href")).toBe(`/runs/${COMPLETED_RUN.runId}/result`);
  });

  it("shows status badge", () => {
    render(<RunCard run={BASE_RUN} />);
    expect(screen.getByTestId("status-badge-in_progress")).toBeInTheDocument();
  });

  it("does not render scores when opportunity is null", () => {
    render(<RunCard run={BASE_RUN} />);
    expect(screen.queryByTestId("run-card-scores")).not.toBeInTheDocument();
  });

  it("does not render headline when opportunity is null", () => {
    render(<RunCard run={BASE_RUN} />);
    expect(screen.queryByTestId("run-card-headline")).not.toBeInTheDocument();
  });

  it("renders headline for completed run", () => {
    render(<RunCard run={COMPLETED_RUN} />);
    expect(screen.getByTestId("run-card-headline")).toHaveTextContent(
      "Strong market pull in underserved segment"
    );
  });

  it("renders three score chips for completed run", () => {
    render(<RunCard run={COMPLETED_RUN} />);
    expect(screen.getByTestId("run-card-scores")).toBeInTheDocument();
    expect(screen.getByTestId("score-chip-venture")).toBeInTheDocument();
    expect(screen.getByTestId("score-chip-confidence")).toBeInTheDocument();
    expect(screen.getByTestId("score-chip-fit")).toBeInTheDocument();
  });

  it("formats scores as whole-number percentages", () => {
    render(<RunCard run={COMPLETED_RUN} />);
    // 0.82 → "82", 0.71 → "71", 0.65 → "65"
    expect(screen.getByTestId("score-chip-venture")).toHaveTextContent("82");
    expect(screen.getByTestId("score-chip-confidence")).toHaveTextContent("71");
    expect(screen.getByTestId("score-chip-fit")).toHaveTextContent("65");
  });

  it("renders failed badge for a failed run", () => {
    const failedRun: FounderRun = { ...BASE_RUN, overall: "failed" };
    render(<RunCard run={failedRun} />);
    expect(screen.getByTestId("status-badge-failed")).toBeInTheDocument();
  });

  it("renders queued badge for a queued run", () => {
    const queuedRun: FounderRun = { ...BASE_RUN, overall: "queued" };
    render(<RunCard run={queuedRun} />);
    expect(screen.getByTestId("status-badge-queued")).toBeInTheDocument();
  });

  it("does not render scores when headline is null even if opportunity exists", () => {
    const runWithNullHeadline: FounderRun = {
      ...COMPLETED_RUN,
      opportunity: { ...COMPLETED_RUN.opportunity!, headline: null },
    };
    render(<RunCard run={runWithNullHeadline} />);
    // Scores still show (headline is separate from scores)
    expect(screen.getByTestId("run-card-scores")).toBeInTheDocument();
    expect(screen.queryByTestId("run-card-headline")).not.toBeInTheDocument();
  });
});
