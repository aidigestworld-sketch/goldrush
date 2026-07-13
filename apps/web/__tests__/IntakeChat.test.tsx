import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import IntakeChat from "../components/IntakeChat";
import type { IntakeTurnResponse } from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, postIntakeTurn: vi.fn() };
});

vi.mock("../lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
    },
  }),
}));

const { postIntakeTurn } = await import("../lib/api");
const mockPost = vi.mocked(postIntakeTurn);

// ── Fixture builders ──────────────────────────────────────────────────────

function makeQuestion(
  text = "What's your professional background?",
  fieldTarget: IntakeTurnResponse["currentQuestion"] extends { fieldTarget: infer F } | null ? F : never = "expertise",
  isFollowUp = false
): IntakeTurnResponse {
  return {
    intakeComplete: false,
    currentQuestion: { text, fieldTarget, isFollowUp },
    contradictionFlag: null,
    questionCount: 1,
  };
}

function makeCompletion(): IntakeTurnResponse {
  return {
    intakeComplete: true,
    currentQuestion: null,
    contradictionFlag: null,
    questionCount: 3,
  };
}

function makeContradiction(overQuestion: IntakeTurnResponse = makeQuestion()): IntakeTurnResponse {
  return {
    ...overQuestion,
    contradictionFlag: {
      detectedAt: new Date().toISOString(),
      field1: "expertise",
      snippet1: "solopreneur",
      field2: "distributionAssets",
      snippet2: "my team built it",
      message: "Earlier you described yourself as a solopreneur, but now mention a team.",
      resolved: false,
    },
  };
}

const FOUNDER_ID = "test-founder-id";

// ── Tests ─────────────────────────────────────────────────────────────────

describe("IntakeChat", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Initial load ─────────────────────────────────────────────────────────

  it("shows loading indicator immediately on mount before first response", () => {
    mockPost.mockResolvedValue(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    expect(screen.getByTestId("loading-indicator")).toBeInTheDocument();
  });

  it("renders the agent question bubble after initial load", async () => {
    mockPost.mockResolvedValue(makeQuestion("What's your professional background?"));
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-message")).toBeInTheDocument()
    );
    expect(screen.getByTestId("agent-message")).toHaveTextContent(
      "What's your professional background?"
    );
  });

  it("calls postIntakeTurn with empty body on mount", async () => {
    mockPost.mockResolvedValue(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith(FOUNDER_ID, {}, "test-token");
  });

  it("shows question count after initial load", async () => {
    mockPost.mockResolvedValue(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("question-count")).toBeInTheDocument());
    expect(screen.getByTestId("question-count")).toHaveTextContent("question 1");
  });

  it("input is disabled until initial load completes", async () => {
    mockPost.mockResolvedValue(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    expect(screen.getByTestId("answer-input")).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTestId("answer-input")).not.toBeDisabled()
    );
  });

  // ── Follow-up label ──────────────────────────────────────────────────────

  it("does not show follow-up label for non-follow-up questions", async () => {
    mockPost.mockResolvedValue(makeQuestion("What's your background?", "expertise", false));
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("agent-message")).toBeInTheDocument());
    expect(screen.queryByTestId("follow-up-label")).not.toBeInTheDocument();
  });

  it("shows follow-up label for follow-up questions", async () => {
    mockPost.mockResolvedValue(makeQuestion("Can you be more specific?", "expertise", true));
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("follow-up-label")).toBeInTheDocument());
  });

  // ── Submit / answer flow ─────────────────────────────────────────────────

  it("appends founder bubble immediately on submit before response returns", async () => {
    let resolve!: (v: IntakeTurnResponse) => void;
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "I built Shopify apps for 6 years." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    expect(screen.getByTestId("founder-message")).toHaveTextContent(
      "I built Shopify apps for 6 years."
    );

    // Clean up the pending promise so the test doesn't leak.
    resolve(makeQuestion("What distribution do you have?", "distributionAssets"));
  });

  it("calls postIntakeTurn with rawAnswer and fieldTarget on submit", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion("What's your background?", "expertise"))
      .mockResolvedValueOnce(makeQuestion("What distribution?", "distributionAssets"));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "6 years on Shopify." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(mockPost).toHaveBeenLastCalledWith(FOUNDER_ID, {
      rawAnswer: "6 years on Shopify.",
      fieldTarget: "expertise",
    }, "test-token");
  });

  it("shows loading indicator while waiting for answer response", async () => {
    let resolve!: (v: IntakeTurnResponse) => void;
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "Some answer." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    expect(screen.getByTestId("loading-indicator")).toBeInTheDocument();
    resolve(makeQuestion("Next question?", "distributionAssets"));
  });

  it("clears the input after submit", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeQuestion("Next?", "distributionAssets"));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "My answer." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    expect((screen.getByTestId("answer-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit when input is empty", async () => {
    mockPost.mockResolvedValueOnce(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.submit(screen.getByTestId("input-form"));
    // Only the initial load call — no second call.
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("submit button is disabled when input is empty", async () => {
    mockPost.mockResolvedValueOnce(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());
    expect(screen.getByTestId("submit-button")).toBeDisabled();
  });

  it("submit button is enabled when input has text", async () => {
    mockPost.mockResolvedValueOnce(makeQuestion());
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "Some text." },
    });
    expect(screen.getByTestId("submit-button")).not.toBeDisabled();
  });

  // ── Contradiction flag ────────────────────────────────────────────────────

  it("renders contradiction alert when contradictionFlag is present", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeContradiction(makeQuestion("Follow-up?", "distributionAssets")));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "My team built our distribution." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.getByTestId("contradiction-message")).toBeInTheDocument()
    );
  });

  it("contradiction alert shows the flag message", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeContradiction(makeQuestion("Follow-up?", "distributionAssets")));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "My team built it." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.getByTestId("contradiction-message")).toHaveTextContent(
        "Earlier you described yourself as a solopreneur"
      )
    );
  });

  it("contradiction alert has role=alert", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeContradiction(makeQuestion("Follow-up?", "distributionAssets")));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "My team built it." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument()
    );
  });

  // ── Completion state ─────────────────────────────────────────────────────

  it("renders completion state when intakeComplete is true", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeCompletion());

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "bootstrapped" },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.getByTestId("completion-state")).toBeInTheDocument()
    );
  });

  it("hides the input form when complete", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeCompletion());

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "bootstrapped" },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.queryByTestId("input-form")).not.toBeInTheDocument()
    );
  });

  it("completion state links to /vertical-request", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeCompletion());

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "bootstrapped" },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.getByTestId("next-step-link")).toBeInTheDocument()
    );
    expect(screen.getByTestId("next-step-link")).toHaveAttribute("href", "/vertical-request");
  });

  it("hides question count when complete", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockResolvedValueOnce(makeCompletion());

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "bootstrapped" },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.queryByTestId("question-count")).not.toBeInTheDocument()
    );
  });

  // ── Error state ──────────────────────────────────────────────────────────

  it("shows error state when initial load fails", async () => {
    mockPost.mockRejectedValueOnce(new Error("Network error"));
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("error-state")).toBeInTheDocument()
    );
  });

  it("displays the error message", async () => {
    mockPost.mockRejectedValueOnce(new Error("API is down"));
    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("error-state")).toHaveTextContent("API is down")
    );
  });

  it("shows retry button that triggers page reload", async () => {
    mockPost.mockRejectedValueOnce(new Error("Network error"));

    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() =>
      expect(screen.getByTestId("retry-button")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("retry-button"));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("shows error state when answer submission fails", async () => {
    mockPost
      .mockResolvedValueOnce(makeQuestion())
      .mockRejectedValueOnce(new Error("Submission failed"));

    render(<IntakeChat founderId={FOUNDER_ID} />);
    await waitFor(() => expect(screen.getByTestId("answer-input")).not.toBeDisabled());

    fireEvent.change(screen.getByTestId("answer-input"), {
      target: { value: "Some answer." },
    });
    fireEvent.submit(screen.getByTestId("input-form"));

    await waitFor(() =>
      expect(screen.getByTestId("error-state")).toBeInTheDocument()
    );
  });
});
