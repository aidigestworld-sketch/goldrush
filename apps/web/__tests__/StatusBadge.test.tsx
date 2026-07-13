import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusBadge from "../components/StatusBadge";
import type { RunOverallStatus } from "../lib/api";

const ALL_STATUSES: RunOverallStatus[] = ["queued", "in_progress", "completed", "failed"];

describe("StatusBadge", () => {
  it.each(ALL_STATUSES)("renders %s badge with correct label", (status) => {
    render(<StatusBadge status={status} />);
    const expectedLabels: Record<RunOverallStatus, string> = {
      queued: "Queued",
      in_progress: "In Progress",
      completed: "Completed",
      failed: "Failed",
    };
    expect(screen.getByText(expectedLabels[status])).toBeInTheDocument();
  });

  it.each(ALL_STATUSES)("renders %s badge with correct data-testid", (status) => {
    const { unmount } = render(<StatusBadge status={status} />);
    expect(screen.getByTestId(`status-badge-${status}`)).toBeInTheDocument();
    unmount();
  });

  it("queued badge has gray background class", () => {
    render(<StatusBadge status="queued" />);
    const badge = screen.getByTestId("status-badge-queued");
    expect(badge.className).toContain("bg-gray-100");
    expect(badge.className).toContain("text-gray-600");
  });

  it("in_progress badge has blue background class", () => {
    render(<StatusBadge status="in_progress" />);
    const badge = screen.getByTestId("status-badge-in_progress");
    expect(badge.className).toContain("bg-blue-50");
    expect(badge.className).toContain("text-blue-700");
  });

  it("completed badge has green background class", () => {
    render(<StatusBadge status="completed" />);
    const badge = screen.getByTestId("status-badge-completed");
    expect(badge.className).toContain("bg-green-50");
    expect(badge.className).toContain("text-green-700");
  });

  it("failed badge has red background class", () => {
    render(<StatusBadge status="failed" />);
    const badge = screen.getByTestId("status-badge-failed");
    expect(badge.className).toContain("bg-red-50");
    expect(badge.className).toContain("text-red-700");
  });

  it("in_progress badge dot has animate-pulse class", () => {
    render(<StatusBadge status="in_progress" />);
    // The animated dot is the aria-hidden span inside the badge
    const badge = screen.getByTestId("status-badge-in_progress");
    const dot = badge.querySelector("[aria-hidden]");
    expect(dot?.className).toContain("animate-pulse");
  });

  it("queued badge dot does not animate", () => {
    render(<StatusBadge status="queued" />);
    const badge = screen.getByTestId("status-badge-queued");
    const dot = badge.querySelector("[aria-hidden]");
    expect(dot?.className).not.toContain("animate-pulse");
  });
});
