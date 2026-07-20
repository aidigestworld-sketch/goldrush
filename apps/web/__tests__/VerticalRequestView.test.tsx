import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import VerticalRequestView from "../components/VerticalRequestView";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, createCheckoutSession: vi.fn() };
});

const { createCheckoutSession } = await import("../lib/api");
const mockCreateCheckout = vi.mocked(createCheckoutSession);

// ── window.location stub ──────────────────────────────────────────────────────
// jsdom's window.location.href assignment triggers navigation events that can
// cause noise; replace with a plain object so we can assert on the href setter.
const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "" },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPage(overrides: Partial<React.ComponentProps<typeof VerticalRequestView>> = {}) {
  return render(
    <VerticalRequestView
      founderId="founder-123"
      accessToken="test-token"
      priceDisplay="$49"
      {...overrides}
    />
  );
}

function selectVertical(slug: string) {
  fireEvent.change(screen.getByTestId("vertical-select"), { target: { value: slug } });
}

function submitForm() {
  fireEvent.submit(screen.getByTestId("vertical-request-form"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VerticalRequestView", () => {
  it("renders the vertical dropdown with all allowed options", () => {
    renderPage();
    const options = screen
      .getAllByRole<HTMLOptionElement>("option")
      .filter((o) => o.value !== "");
    const values = options.map((o) => o.value);
    expect(values).toContain("shopify_subscriptions");
    expect(values).toContain("b2b_customer_support_saas");
  });

  it("shows no vertical description until one is selected", () => {
    renderPage();
    expect(screen.queryByTestId("vertical-description")).not.toBeInTheDocument();
  });

  it("shows the selected vertical's description after selection", () => {
    renderPage();
    selectVertical("shopify_subscriptions");
    expect(screen.getByTestId("vertical-description")).toHaveTextContent(/Shopify/i);
  });

  it("swaps the description when a different vertical is selected", () => {
    renderPage();
    selectVertical("shopify_subscriptions");
    expect(screen.getByTestId("vertical-description")).toHaveTextContent(/Shopify/i);
    selectVertical("b2b_customer_support_saas");
    expect(screen.getByTestId("vertical-description")).toHaveTextContent(/customer.support/i);
  });

  it("shows the price in the start button", () => {
    renderPage();
    expect(screen.getByTestId("start-analysis-button")).toHaveTextContent("$49");
  });

  it("disables the submit button until a vertical is selected", () => {
    renderPage();
    expect(screen.getByTestId("start-analysis-button")).toBeDisabled();
    selectVertical("shopify_subscriptions");
    expect(screen.getByTestId("start-analysis-button")).not.toBeDisabled();
  });

  it("submitting without a selection does not call the API", async () => {
    renderPage();
    submitForm();
    // Give React a tick to run any queued effects.
    await Promise.resolve();
    expect(mockCreateCheckout).not.toHaveBeenCalled();
  });

  it("does not show cancel notice by default", () => {
    renderPage();
    expect(screen.queryByTestId("cancel-notice")).not.toBeInTheDocument();
  });

  it("shows cancel notice when initialCanceled is true", () => {
    renderPage({ initialCanceled: true });
    expect(screen.getByTestId("cancel-notice")).toBeInTheDocument();
    expect(screen.getByTestId("cancel-notice")).toHaveTextContent(/canceled/i);
  });

  it("dismisses the cancel notice when the dismiss button is clicked", () => {
    renderPage({ initialCanceled: true });
    fireEvent.click(screen.getByTestId("dismiss-cancel-notice"));
    expect(screen.queryByTestId("cancel-notice")).not.toBeInTheDocument();
  });

  it("submitting calls createCheckoutSession with the selected vertical and credentials", async () => {
    mockCreateCheckout.mockResolvedValueOnce({ url: "https://checkout.stripe.com/pay/cs_test" });
    renderPage();
    selectVertical("b2b_customer_support_saas");
    submitForm();

    await waitFor(() => {
      expect(mockCreateCheckout).toHaveBeenCalledWith(
        "founder-123",
        "b2b_customer_support_saas",
        "test-token"
      );
    });
  });

  it("redirects browser to the Stripe checkout URL on success", async () => {
    const checkoutUrl = "https://checkout.stripe.com/pay/cs_test_123";
    mockCreateCheckout.mockResolvedValueOnce({ url: checkoutUrl });
    renderPage();
    selectVertical("shopify_subscriptions");
    submitForm();

    await waitFor(() => {
      expect(window.location.href).toBe(checkoutUrl);
    });
  });

  it("shows loading label and disables submit while checkout is being created", async () => {
    let resolve: (value: { url: string }) => void;
    mockCreateCheckout.mockReturnValueOnce(new Promise((r) => { resolve = r; }));

    renderPage();
    selectVertical("shopify_subscriptions");
    submitForm();

    expect(screen.getByTestId("start-analysis-button")).toHaveTextContent(/preparing/i);
    expect(screen.getByTestId("start-analysis-button")).toBeDisabled();

    // Clean up the dangling promise so the effect can settle
    resolve!({ url: "https://checkout.stripe.com/pay/cs_test" });
  });

  it("shows an inline error and re-enables the button when checkout creation fails", async () => {
    mockCreateCheckout.mockRejectedValueOnce(new Error("Network error"));
    renderPage();
    selectVertical("shopify_subscriptions");
    submitForm();

    await waitFor(() => {
      expect(screen.getByTestId("checkout-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("checkout-error")).toHaveTextContent("Network error");
    expect(screen.getByTestId("start-analysis-button")).not.toBeDisabled();
  });

  it("does not show an error message initially", () => {
    renderPage();
    expect(screen.queryByTestId("checkout-error")).not.toBeInTheDocument();
  });
});
