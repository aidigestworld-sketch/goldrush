import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LiveScanPanel from "../components/landing/LiveScanPanel";

describe("LiveScanPanel", () => {
  it("renders the panel wrapper", () => {
    render(<LiveScanPanel />);
    expect(screen.getByTestId("live-scan-panel")).toBeInTheDocument();
  });

  it("renders the SCANNING status indicator", () => {
    render(<LiveScanPanel />);
    const status = screen.getByTestId("scan-status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent(/scanning/i);
  });

  // ── The three cycling finding callouts ─────────────────────
  // These labels are the page's signature copy. Pin them so a
  // future rewrite can't silently swap the framing.

  it("renders the FRICTION SPIKE finding", () => {
    render(<LiveScanPanel />);
    const finding = screen.getByTestId("finding-1");
    expect(finding).toHaveTextContent(/friction spike/i);
    expect(finding).toHaveTextContent(/shipping-cost step/i);
  });

  it("renders the PRICING GAP finding", () => {
    render(<LiveScanPanel />);
    const finding = screen.getByTestId("finding-2");
    expect(finding).toHaveTextContent(/pricing gap/i);
    expect(finding).toHaveTextContent(/22%/i);
  });

  it("renders the CHURN RISK finding", () => {
    render(<LiveScanPanel />);
    const finding = screen.getByTestId("finding-3");
    expect(finding).toHaveTextContent(/churn risk/i);
    expect(finding).toHaveTextContent(/3 weeks/i);
  });

  it("renders all three findings simultaneously (they are always mounted; only the animation cycles them)", () => {
    render(<LiveScanPanel />);
    expect(screen.getByTestId("finding-1")).toBeInTheDocument();
    expect(screen.getByTestId("finding-2")).toBeInTheDocument();
    expect(screen.getByTestId("finding-3")).toBeInTheDocument();
  });
});
