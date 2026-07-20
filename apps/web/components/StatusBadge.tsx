import type { RunOverallStatus } from "../lib/api";

// Tailwind classes for each status. Using full class strings (not dynamic
// construction) so Tailwind's content scanner can statically detect them.
const BADGE_CLASSES: Record<RunOverallStatus, string> = {
  queued: "bg-gray-100 text-gray-600",
  in_progress: "bg-blue-50 text-blue-700",
  completed: "bg-green-50 text-green-700",
  insufficient_evidence: "bg-amber-50 text-amber-800",
  failed: "bg-red-50 text-red-700",
};

const DOT_CLASSES: Record<RunOverallStatus, string> = {
  queued: "bg-gray-400",
  in_progress: "bg-blue-500 animate-pulse",
  completed: "bg-green-500",
  insufficient_evidence: "bg-amber-500",
  failed: "bg-red-500",
};

const LABELS: Record<RunOverallStatus, string> = {
  queued: "Queued",
  in_progress: "In Progress",
  completed: "Completed",
  insufficient_evidence: "Insufficient Evidence",
  failed: "Failed",
};

interface Props {
  status: RunOverallStatus;
}

export default function StatusBadge({ status }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_CLASSES[status]}`}
      data-testid={`status-badge-${status}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[status]}`}
        aria-hidden="true"
      />
      {LABELS[status]}
    </span>
  );
}
