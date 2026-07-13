import type { StepStatus } from "../lib/api";

interface Props {
  status: StepStatus;
  /** px size for the icon square — defaults to 20 (h-5 w-5) */
  size?: number;
}

// Each icon is a 24-viewport SVG sized via className. Using full class
// strings (no dynamic construction) so Tailwind can statically detect them.

export default function StageStatusIcon({ status, size = 20 }: Props) {
  const px = `${size}px`;

  if (status === "succeeded") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ width: px, height: px }}
        className="text-green-500 shrink-0"
        aria-label="Succeeded"
        data-testid="icon-succeeded"
      >
        <path
          fillRule="evenodd"
          d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm13.36-1.814a.75.75 0 10-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.14-.094l3.75-5.25z"
          clipRule="evenodd"
        />
      </svg>
    );
  }

  if (status === "failed_permanent") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ width: px, height: px }}
        className="text-red-500 shrink-0"
        aria-label="Failed"
        data-testid="icon-failed_permanent"
      >
        <path
          fillRule="evenodd"
          d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm-1.72 6.97a.75.75 0 10-1.06 1.06L10.94 12l-1.72 1.72a.75.75 0 101.06 1.06L12 13.06l1.72 1.72a.75.75 0 101.06-1.06L13.06 12l1.72-1.72a.75.75 0 10-1.06-1.06L12 10.94l-1.72-1.72z"
          clipRule="evenodd"
        />
      </svg>
    );
  }

  if (status === "running") {
    // Spinning arc — visual consistency with StatusBadge's animate-pulse pattern
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        style={{ width: px, height: px }}
        className="text-blue-500 shrink-0 animate-spin"
        aria-label="Running"
        data-testid="icon-running"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeOpacity="0.25"
        />
        <path
          d="M12 3a9 9 0 019 9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === "pending") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        style={{ width: px, height: px }}
        className="text-gray-400 shrink-0"
        aria-label="Pending"
        data-testid="icon-pending"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 7v5l3 3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // not_started — hollow gray circle
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      style={{ width: px, height: px }}
      className="text-gray-300 shrink-0"
      aria-label="Not started"
      data-testid="icon-not_started"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
