import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import RunResultView from "../components/RunResultView";
import type { RunResult, OpportunityDetail, EvaluatedCandidate } from "../lib/api";

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
  opportunity: OpportunityDetail | null = FULL_OPPORTUNITY,
  candidates: EvaluatedCandidate[] = [],
  runStatus: string = overall === "completed" ? "completed" : overall
): RunResult {
  return {
    runId: "run-result-1",
    overall,
    runStatus,
    vertical: "shopify_subscriptions",
    opportunity,
    candidates,
  };
}

// Real numbers from run aae43d53-09f5-441d-92b5-e5d05154198c (the
// 2026-07-17 shopify_subscriptions run that produced ONE scored
// candidate that was gated out on min-founder-fit). Used as the
// canonical fixture for the "evaluated but not promoted" case.
const AAE43D53_CANDIDATE: EvaluatedCandidate = {
  id: "aae43d53-cand-1",
  status: "deprecated",
  opportunityQuality: 0.46,
  confidenceScore: 1.0,
  founderFitScore: 0.20, // stored 20/100, normalised at API boundary
  ventureScore: null,     // null because min-fit gate blocked venture calc
  founderFitRationale:
    "Founder's background is in adjacent SaaS but lacks direct experience with subscription-billing merchants. The specific dunning/win-back mechanism the hypothesis targets requires operator familiarity we couldn't confirm from the profile.",
  deprecationReason: "failed_gate",
  confidenceCoverageGate: true,
  incompleteComposition: false,
};

const COMPLETED = makeResult("completed", FULL_OPPORTUNITY, [
  // Include the promoted candidate too — the real API returns every candidate row.
  {
    id: "promoted-1", status: "promoted",
    opportunityQuality: 0.72, confidenceScore: 0.74, founderFitScore: 0.69,
    ventureScore: 0.82, founderFitRationale: FULL_OPPORTUNITY.founderFitRationale,
    deprecationReason: null, confidenceCoverageGate: true, incompleteComposition: false,
  },
]);
const COMPLETED_NO_OPP = makeResult("completed", null); // no candidates → "no scorable" state
const COMPLETED_EVAL_NOT_PROMOTED = makeResult(
  "completed",
  null,
  [AAE43D53_CANDIDATE],
  "insufficient_evidence"
);
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

// ── RunResultView — zero candidates ever composed (honest empty state) ────

describe("RunResultView — zero candidates ever composed", () => {
  beforeEach(() => {
    render(<RunResultView result={COMPLETED_NO_OPP} runId="run-result-1" />);
  });

  it("renders the no-scorable-opportunity state container", () => {
    expect(screen.getByTestId("no-opportunity-state")).toBeInTheDocument();
  });

  it("shows message mentioning the vertical", () => {
    expect(screen.getByTestId("no-opportunity-state")).toHaveTextContent(
      "Shopify Subscriptions"
    );
  });

  it("shows an honest, non-fabricating message", () => {
    // Distinct from the evaluated-not-promoted state: no per-candidate detail
    // to render, so we tell the founder plainly that nothing scorable was found.
    expect(screen.getByTestId("no-opportunity-state")).toHaveTextContent(
      "didn't support composing a candidate to score"
    );
  });

  it("has a back-to-status link", () => {
    expect(screen.getByTestId("back-to-status-link")).toBeInTheDocument();
    expect(screen.getByTestId("back-to-status-link")).toHaveAttribute(
      "href",
      "/runs/run-result-1"
    );
  });

  it("does NOT render fabricated per-candidate detail", () => {
    // Regression guard: the "no candidates" branch must NOT accidentally show
    // score chips or rationale panels (there's no data behind them).
    expect(screen.queryByTestId("opportunity-headline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("score-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("candidates-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("candidate-card-0")).not.toBeInTheDocument();
    expect(screen.queryByTestId("evaluated-not-promoted-state")).not.toBeInTheDocument();
  });
});

// ── RunResultView — evaluated but not promoted (aae43d53 fixture) ──────────

describe("RunResultView — evaluated but not promoted", () => {
  beforeEach(() => {
    render(<RunResultView result={COMPLETED_EVAL_NOT_PROMOTED} runId="run-result-1" />);
  });

  it("renders the evaluated-not-promoted state container, NOT the plain no-opportunity fallback", () => {
    expect(screen.getByTestId("evaluated-not-promoted-state")).toBeInTheDocument();
    expect(screen.queryByTestId("no-opportunity-state")).not.toBeInTheDocument();
  });

  it("shows 'No opportunity cleared the bar' headline", () => {
    expect(screen.getByTestId("not-promoted-headline")).toHaveTextContent(
      "No opportunity cleared the bar"
    );
  });

  it("acknowledges the number of candidates evaluated", () => {
    expect(screen.getByTestId("evaluated-not-promoted-state")).toHaveTextContent(
      "We evaluated one candidate"
    );
  });

  it("renders the candidate's Quality score at its real value (46%)", () => {
    expect(screen.getByTestId("candidate-0-score-quality")).toHaveTextContent("46%");
  });

  it("renders the candidate's Confidence score at 100%", () => {
    expect(screen.getByTestId("candidate-0-score-confidence")).toHaveTextContent("100%");
  });

  it("renders founder-fit at 20%, NOT 2000% (regression: earlier 40 rendered as 4000% on promoted view)", () => {
    expect(screen.getByTestId("candidate-0-score-founder-fit")).toHaveTextContent("20%");
    expect(screen.getByTestId("candidate-0-score-founder-fit")).not.toHaveTextContent("2000%");
  });

  it("translates deprecationReason='failed_gate' into a human sentence", () => {
    expect(screen.getByTestId("candidate-0-gate-reason")).toHaveTextContent(
      "Founder-fit fell below the minimum threshold"
    );
  });

  it("shows the full founder-fit rationale text prominently", () => {
    const panel = screen.getByTestId("candidate-0-founder-fit-rationale");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "Founder's background is in adjacent SaaS but lacks direct experience"
    );
  });

  it("keeps the back-to-status link", () => {
    expect(screen.getByTestId("back-to-status-link")).toBeInTheDocument();
    expect(screen.getByTestId("back-to-status-link")).toHaveAttribute(
      "href",
      "/runs/run-result-1"
    );
  });

  it("does NOT render the promoted-opportunity chrome (score-row, rationale-section, risk-section)", () => {
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
