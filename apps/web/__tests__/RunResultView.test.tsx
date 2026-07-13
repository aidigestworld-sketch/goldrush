import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import RunResultView from "../components/RunResultView";
import type { RunResult, OpportunityDetail } from "../lib/api";

// ── Mock setup ───────────���────────────────────────────────────────────────

// Mock the API so the page-level redirect tests can control getRunResult.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getRunResult: vi.fn() };
});

const { getRunResult } = await import("../lib/api");
const mockGetRunResult = vi.mocked(getRunResult);

// Mock Supabase server client — cookies() is unavailable outside a Next.js request scope.
vi.mock("../lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
    },
  }),
}));

// Override next/navigation so redirect is a spy rather than a throw.
const mockRedirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Import via the `@` alias so Vite doesn't mis-resolve relative paths
// from a directory containing dynamic segment brackets like `[runId]`.
const { default: RunResultPage } = await import(
  "@/app/runs/[runId]/result/page"
);

// ── Fixture builders ──────────────────────────────────────────────────────

const FULL_OPPORTUNITY: OpportunityDetail = {
  ventureScore: 0.82,
  confidenceScore: 0.74,
  founderFitScore: 0.69,
  founderFitRationale: "Founder has 8 years in logistics SaaS — direct domain match.",
  rationaleBullets: [
    "Shopify merchants lose an average of 23% of subscription revenue to churn",
    "No existing tool addresses the dunning + win-back flow end-to-end",
    "Adjacent market (email automation) validates willingness to pay at $150+/mo",
  ],
  riskSummary: [
    "Shopify's own retention tooling could be upgraded to close the gap",
    "CAC payback period likely exceeds 12 months in year one",
  ],
};

function makeResult(
  overall: RunResult["overall"],
  opportunity: OpportunityDetail | null = FULL_OPPORTUNITY
): RunResult {
  return {
    runId: "run-result-1",
    overall,
    vertical: "shopify_subscriptions",
    opportunity,
  };
}

const COMPLETED = makeResult("completed");
const COMPLETED_NO_OPP = makeResult("completed", null);
const IN_PROGRESS = makeResult("in_progress", null);
const FAILED = makeResult("failed", null);

// ── RunResultView — full opportunity ─────────────────────────────────────

describe("RunResultView — full opportunity", () => {
  beforeEach(() => {
    render(<RunResultView result={COMPLETED} runId="run-result-1" />);
  });

  it("renders the view container", () => {
    expect(screen.getByTestId("run-result-view")).toBeInTheDocument();
  });

  it("renders the headline from rationaleBullets[0]", () => {
    expect(screen.getByTestId("opportunity-headline")).toHaveTextContent(
      "Shopify merchants lose an average of 23% of subscription revenue to churn"
    );
  });

  it("renders the vertical as title case", () => {
    expect(screen.getByText("Shopify Subscriptions")).toBeInTheDocument();
  });

  it("renders the score row", () => {
    expect(screen.getByTestId("score-row")).toBeInTheDocument();
  });

  it("renders venture score as a whole-number percentage", () => {
    expect(screen.getByTestId("score-chip-venture")).toHaveTextContent("82%");
  });

  it("renders confidence score as a whole-number percentage", () => {
    expect(screen.getByTestId("score-chip-confidence")).toHaveTextContent("74%");
  });

  it("renders founder fit score as a whole-number percentage", () => {
    expect(screen.getByTestId("score-chip-founder-fit")).toHaveTextContent("69%");
  });

  it("renders the rationale section", () => {
    expect(screen.getByTestId("rationale-section")).toBeInTheDocument();
  });

  it("renders all rationale bullets", () => {
    expect(screen.getByTestId("rationale-bullet-0")).toBeInTheDocument();
    expect(screen.getByTestId("rationale-bullet-1")).toBeInTheDocument();
    expect(screen.getByTestId("rationale-bullet-2")).toBeInTheDocument();
    expect(screen.getByTestId("rationale-bullet-0")).toHaveTextContent(
      "Shopify merchants lose"
    );
  });

  it("renders the risk section", () => {
    expect(screen.getByTestId("risk-section")).toBeInTheDocument();
  });

  it("renders all risk bullets", () => {
    expect(screen.getByTestId("risk-bullet-0")).toBeInTheDocument();
    expect(screen.getByTestId("risk-bullet-1")).toBeInTheDocument();
    expect(screen.getByTestId("risk-bullet-0")).toHaveTextContent(
      "Shopify's own retention tooling"
    );
  });

  it("renders the founder fit rationale when present", () => {
    expect(screen.getByTestId("founder-fit-rationale")).toBeInTheDocument();
    expect(screen.getByTestId("founder-fit-rationale")).toHaveTextContent(
      "Founder has 8 years in logistics SaaS"
    );
  });

  it("does not show the no-opportunity state", () => {
    expect(screen.queryByTestId("no-opportunity-state")).not.toBeInTheDocument();
  });

  it("renders a back-to-status link", () => {
    const backLinks = screen.getAllByRole("link");
    const backLink = backLinks.find((l) => l.textContent?.includes("Back to status"));
    expect(backLink).toBeDefined();
    expect(backLink?.getAttribute("href")).toBe("/runs/run-result-1");
  });
});

// ── RunResultView — no founder fit rationale ──────────────────────────────

describe("RunResultView — no founder fit rationale", () => {
  it("omits the founder fit section when founderFitRationale is null", () => {
    const result = makeResult("completed", { ...FULL_OPPORTUNITY, founderFitRationale: null });
    render(<RunResultView result={result} runId="r1" />);
    expect(screen.queryByTestId("founder-fit-rationale")).not.toBeInTheDocument();
  });
});

// ── RunResultView — score edge cases ─���───────────────────────────────────

describe("RunResultView — score formatting", () => {
  it("rounds scores to the nearest whole percentage", () => {
    const result = makeResult("completed", {
      ...FULL_OPPORTUNITY,
      ventureScore: 0.826,   // → 83%
      confidenceScore: 0.744, // → 74%
      founderFitScore: 0.695, // → 70%
    });
    render(<RunResultView result={result} runId="r1" />);
    expect(screen.getByTestId("score-chip-venture")).toHaveTextContent("83%");
    expect(screen.getByTestId("score-chip-confidence")).toHaveTextContent("74%");
    expect(screen.getByTestId("score-chip-founder-fit")).toHaveTextContent("70%");
  });

  it("falls back to 'Analysis Complete' headline when rationaleBullets is empty", () => {
    const result = makeResult("completed", { ...FULL_OPPORTUNITY, rationaleBullets: [] });
    render(<RunResultView result={result} runId="r1" />);
    expect(screen.getByTestId("opportunity-headline")).toHaveTextContent("Analysis Complete");
  });
});

// ── RunResultView — no opportunity promoted (empty state) ─────────────────

describe("RunResultView — no opportunity promoted", () => {
  beforeEach(() => {
    render(<RunResultView result={COMPLETED_NO_OPP} runId="run-result-1" />);
  });

  it("renders the no-opportunity state container", () => {
    expect(screen.getByTestId("no-opportunity-state")).toBeInTheDocument();
  });

  it("shows message mentioning the vertical", () => {
    expect(screen.getByTestId("no-opportunity-state")).toHaveTextContent(
      "Shopify Subscriptions"
    );
  });

  it("shows the honest 'no opportunity cleared the bar' message", () => {
    expect(screen.getByTestId("no-opportunity-state")).toHaveTextContent(
      "no opportunity cleared the bar"
    );
  });

  it("has a back-to-status link", () => {
    expect(screen.getByTestId("back-to-status-link")).toBeInTheDocument();
    expect(screen.getByTestId("back-to-status-link")).toHaveAttribute(
      "href",
      "/runs/run-result-1"
    );
  });

  it("does not render headline, scores, or sections", () => {
    expect(screen.queryByTestId("opportunity-headline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("score-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rationale-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("risk-section")).not.toBeInTheDocument();
  });
});

// ── RunResultPage — redirect behaviour ──��─────────────────────────────────
// The page is an async server component (plain async function), so we call
// it directly rather than rendering it with React Testing Library.

describe("RunResultPage — redirect", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
  });

  it("redirects to status page when overall is in_progress", async () => {
    mockGetRunResult.mockResolvedValueOnce(IN_PROGRESS);
    await RunResultPage({ params: Promise.resolve({ runId: "r1" }) });
    expect(mockRedirect).toHaveBeenCalledWith("/runs/r1");
  });

  it("redirects to status page when overall is queued", async () => {
    mockGetRunResult.mockResolvedValueOnce(makeResult("queued", null));
    await RunResultPage({ params: Promise.resolve({ runId: "r1" }) });
    expect(mockRedirect).toHaveBeenCalledWith("/runs/r1");
  });

  it("redirects to status page when overall is failed", async () => {
    mockGetRunResult.mockResolvedValueOnce(FAILED);
    await RunResultPage({ params: Promise.resolve({ runId: "r1" }) });
    expect(mockRedirect).toHaveBeenCalledWith("/runs/r1");
  });

  it("does not redirect when overall is completed", async () => {
    mockGetRunResult.mockResolvedValueOnce(COMPLETED);
    const element = await RunResultPage({ params: Promise.resolve({ runId: "r1" }) });
    render(element as React.ReactElement);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId("run-result-view")).toBeInTheDocument();
  });

  it("renders RunResultView with opportunity data when completed", async () => {
    mockGetRunResult.mockResolvedValueOnce(COMPLETED);
    const element = await RunResultPage({
      params: Promise.resolve({ runId: "run-result-1" }),
    });
    render(element as React.ReactElement);
    expect(screen.getByTestId("opportunity-headline")).toBeInTheDocument();
  });

  it("renders no-opportunity empty state when completed but no promotion", async () => {
    mockGetRunResult.mockResolvedValueOnce(COMPLETED_NO_OPP);
    const element = await RunResultPage({
      params: Promise.resolve({ runId: "run-result-1" }),
    });
    render(element as React.ReactElement);
    expect(screen.getByTestId("no-opportunity-state")).toBeInTheDocument();
  });
});

// ── Import React for type annotation in page tests ────────────────────────
import React from "react";
