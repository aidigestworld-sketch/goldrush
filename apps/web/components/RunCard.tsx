"use client";

import Link from "next/link";
import type { FounderRun } from "../lib/api";
import StatusBadge from "./StatusBadge";

// Human-readable relative time — computed client-side so it reflects the
// browser's clock rather than the server's render time.
export function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
  if (diffHours > 0) return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  if (diffMins > 0) return diffMins === 1 ? "1 minute ago" : `${diffMins} minutes ago`;
  return "just now";
}

// "shopify_subscriptions" → "Shopify Subscriptions"
export function formatVertical(vertical: string): string {
  return vertical
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function ScoreChip({ label, value }: { label: string; value: number }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
      data-testid={`score-chip-${label.toLowerCase()}`}
    >
      <span className="font-medium text-gray-500">{label}</span>
      <span className="font-semibold">{(value * 100).toFixed(0)}</span>
    </span>
  );
}

interface Props {
  run: FounderRun;
}

export default function RunCard({ run }: Props) {
  // Completed runs (winner promoted) AND insufficient_evidence runs
  // (candidates evaluated but none passed) both have result-page content
  // worth showing; every other state links to the status/progress view.
  const href =
    run.overall === "completed" || run.overall === "insufficient_evidence"
      ? `/runs/${run.runId}/result`
      : `/runs/${run.runId}`;

  return (
    <Link
      href={href}
      className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-all hover:border-gray-300 hover:shadow-md"
      data-testid={`run-card-${run.runId}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-900 truncate">
            {formatVertical(run.vertical)}
          </p>
          <p className="mt-0.5 text-sm text-gray-500">
            {formatRelativeTime(run.createdAt)}
          </p>

          {run.opportunity?.headline && (
            <p
              className="mt-2 text-sm text-gray-700 line-clamp-2"
              data-testid="run-card-headline"
            >
              {run.opportunity.headline}
            </p>
          )}

          {run.opportunity && (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="run-card-scores">
              <ScoreChip label="Venture" value={run.opportunity.ventureScore} />
              <ScoreChip label="Confidence" value={run.opportunity.confidenceScore} />
              <ScoreChip label="Fit" value={run.opportunity.founderFitScore} />
            </div>
          )}
        </div>

        <StatusBadge status={run.overall} />
      </div>
    </Link>
  );
}
