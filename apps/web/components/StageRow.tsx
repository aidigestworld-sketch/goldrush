"use client";

import { useState } from "react";
import type { StepInfo } from "../lib/api";
import StageStatusIcon from "./StageStatusIcon";

/** "1.2s" / "42s" / "3m 12s" — shown only when both timestamps are present */
export function formatDuration(startedAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

const ERROR_TRUNCATE = 120;

interface Props {
  info: StepInfo;
  /** Indent left edge to line up inside fork cards */
  compact?: boolean;
}

export default function StageRow({ info, compact = false }: Props) {
  const [errorExpanded, setErrorExpanded] = useState(false);

  const duration =
    info.startedAt && info.completedAt
      ? formatDuration(info.startedAt, info.completedAt)
      : null;

  const hasLongError =
    info.lastError !== null && info.lastError.length > ERROR_TRUNCATE;
  const visibleError =
    info.lastError === null
      ? null
      : errorExpanded
      ? info.lastError
      : info.lastError.slice(0, ERROR_TRUNCATE);

  return (
    <div
      className={`flex flex-col gap-1 ${compact ? "py-2 px-3" : "py-2.5 px-4"}`}
      data-testid={`stage-row-${info.step}`}
    >
      <div className="flex items-center gap-3">
        <StageStatusIcon status={info.status} />

        <span className="flex-1 text-sm font-medium text-gray-800">
          {info.label}
        </span>

        {duration && (
          <span className="text-xs text-gray-400 tabular-nums">{duration}</span>
        )}

        {info.status === "running" && (
          <span className="text-xs text-blue-600 animate-pulse">running…</span>
        )}

        {info.status === "pending" && (
          <span className="text-xs text-gray-400">queued</span>
        )}
      </div>

      {/* Inline error for failed_permanent steps */}
      {info.status === "failed_permanent" && info.lastError && (
        <div
          className="ml-8 rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700"
          data-testid={`stage-error-${info.step}`}
        >
          <p className="font-mono leading-relaxed break-all">
            {visibleError}
            {hasLongError && !errorExpanded && "…"}
          </p>
          {hasLongError && (
            <button
              onClick={() => setErrorExpanded((v) => !v)}
              className="mt-1 text-red-500 hover:text-red-700 underline underline-offset-2"
            >
              {errorExpanded ? "Show less" : "Show full error"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
