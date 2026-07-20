import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import WaitlistForm from "../components/landing/WaitlistForm";

// ── Fetch mock helpers ─────────────────────────────────────────────

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFetchServerError() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ error: "server_error" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFetchPending() {
  let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  const promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(
    (r) => {
      resolve = r;
    }
  );
  const fetchMock = vi.fn().mockReturnValue(promise);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, resolve };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("WaitlistForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the email input and submit button", () => {
    render(<WaitlistForm />);
    expect(screen.getByTestId("waitlist-email-input")).toBeInTheDocument();
    expect(screen.getByTestId("waitlist-submit")).toBeInTheDocument();
  });

  it("submit button is disabled when input is empty", () => {
    render(<WaitlistForm />);
    expect(screen.getByTestId("waitlist-submit")).toBeDisabled();
  });

  it("submit button is enabled once an email is typed", () => {
    render(<WaitlistForm />);
    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "user@example.com" },
    });
    expect(screen.getByTestId("waitlist-submit")).not.toBeDisabled();
  });

  // ── Invalid email → inline error, no request ─────────────────────

  it("shows inline error on submit when email format is invalid", async () => {
    const fetchMock = mockFetchOk();
    render(<WaitlistForm />);

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "not-an-email" },
    });
    fireEvent.submit(screen.getByTestId("waitlist-form"));

    await waitFor(() =>
      expect(screen.getByTestId("waitlist-error")).toBeInTheDocument()
    );
    expect(screen.getByTestId("waitlist-error")).toHaveTextContent(/valid email/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("waitlist-success")).not.toBeInTheDocument();
  });

  it("clears the inline error when the user edits the email", async () => {
    mockFetchOk();
    render(<WaitlistForm />);

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "bad" },
    });
    fireEvent.submit(screen.getByTestId("waitlist-form"));
    await waitFor(() =>
      expect(screen.getByTestId("waitlist-error")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "bad@" },
    });
    expect(screen.queryByTestId("waitlist-error")).not.toBeInTheDocument();
  });

  // ── Happy path → success state replaces form ─────────────────────

  it("shows success state after a successful submit", async () => {
    const fetchMock = mockFetchOk();
    render(<WaitlistForm />);

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "founder@example.com" },
    });
    fireEvent.submit(screen.getByTestId("waitlist-form"));

    await waitFor(() =>
      expect(screen.getByTestId("waitlist-success")).toBeInTheDocument()
    );
    expect(screen.getByTestId("waitlist-success")).toHaveTextContent(/on the list/i);
    expect(screen.queryByTestId("waitlist-form")).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/waitlist");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      email: "founder@example.com",
      website: "",
    });
  });

  it("shows a loading label on the submit button while the request is in flight", async () => {
    const { resolve } = mockFetchPending();
    render(<WaitlistForm />);

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "founder@example.com" },
    });
    fireEvent.submit(screen.getByTestId("waitlist-form"));

    await waitFor(() =>
      expect(screen.getByTestId("waitlist-submit")).toHaveTextContent(/joining/i)
    );
    expect(screen.getByTestId("waitlist-submit")).toBeDisabled();
    expect(screen.getByTestId("waitlist-email-input")).toBeDisabled();

    resolve({ ok: true, json: async () => ({ ok: true }) });
    await waitFor(() =>
      expect(screen.getByTestId("waitlist-success")).toBeInTheDocument()
    );
  });

  // ── Server / network failures ────────────────────────────────────

  it("shows generic error on server failure", async () => {
    mockFetchServerError();
    render(<WaitlistForm />);

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "founder@example.com" },
    });
    fireEvent.submit(screen.getByTestId("waitlist-form"));

    await waitFor(() =>
      expect(screen.getByTestId("waitlist-error")).toBeInTheDocument()
    );
    expect(screen.getByTestId("waitlist-error")).toHaveTextContent(/something went wrong/i);
    expect(screen.queryByTestId("waitlist-success")).not.toBeInTheDocument();
  });

  it("shows a generic error when fetch rejects (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<WaitlistForm />);

    fireEvent.change(screen.getByTestId("waitlist-email-input"), {
      target: { value: "founder@example.com" },
    });
    fireEvent.submit(screen.getByTestId("waitlist-form"));

    await waitFor(() =>
      expect(screen.getByTestId("waitlist-error")).toBeInTheDocument()
    );
  });
});
