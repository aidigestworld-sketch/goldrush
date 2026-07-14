"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { RunStatus, Stage } from "../lib/api";
import { getRunStatus, retryRun } from "../lib/api";
import StageRow from "./StageRow";
import ForkStage from "./ForkStage";
import StatusBadge from "./StatusBadge";
import { formatVertical } from "./RunCard";

// 4 s is well within [3-5 s] from the spec.
export const DEFAULT_POLL_INTERVAL_MS = 4000;

function isTerminal(overall: RunStatus["run"]["overall"]) {
  return overall === "completed" || overall === "failed";
}

function renderStage(stage: Stage, idx: number) {
  if (stage.type === "fork") {
    return <ForkStage key={`fork-${idx}`} branches={stage.branches} />;
  }
  return (
    <div key={stage.step} className="border-b border-gray-100 last:border-0">
      <StageRow info={stage} />
    </div>
  );
}

type RetryState = "idle" | "retrying" | "error";

interface Props {
  runId: string;
  initialData: RunStatus;
  /** Supabase access token forwarded from the server component for POST /retry. */
  accessToken?: string;
  /** Override for tests — pass a small value to avoid real waits. */
  pollIntervalMs?: number;
}

export default function RunStatusView({
  runId,
  initialData,
  accessToken,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: Props) {
  const [data, setData] = useState<RunStatus>(initialData);
  const [retryState, setRetryState] = useState<RetryState>("idle");
  const [retryError, setRetryError] = useState<string | null>(null);

  async function handleRetry() {
    setRetryState("retrying");
    setRetryError(null);
    try {
      await retryRun(runId, accessToken);
      const fresh = await getRunStatus(runId);
      setData(fresh);
      setRetryState("idle");
    } catch (err) {
      setRetryError((err as Error).message);
      setRetryState("error");
    }
  }

  // Poll while the run is not yet in a terminal state. React's effect
  // cleanup clears the interval; when data.run.overall changes to a
  // terminal value the effect re-runs, returns early, and no new interval
  // is set.
  useEffect(() => {
    if (isTerminal(data.run.overall)) return;

    const id = setInterval(async () => {
      try {
        const fresh = await getRunStatus(runId);
        setData(fresh);
      } catch {
        // Keep showing last known state — transient network errors shouldn't crash the view.
      }
    }, pollIntervalMs);

    return () => clearInterval(id);
  }, [data.run.overall, runId, pollIntervalMs]);

  const { run, stages } = data;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10" data-testid="run-status-view">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-gray-500 hover:text-gray-700 mb-3 inline-block"
        >
          ← Your Analyses
        </Link>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">
              {run.vertical ? formatVertical(run.vertical) : "Analysis"}
            </h1>
            {run.startedAt && (
              <p className="mt-0.5 text-sm text-gray-500">
                Started{" "}
                {new Date(run.startedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            )}
          </div>
          <StatusBadge status={run.overall} />
        </div>
      </div>

      {/* Retry — only shown when failed */}
      {run.overall === "failed" && (
        <div className="mb-5" data-testid="retry-container">
          <button
            onClick={handleRetry}
            disabled={retryState === "retrying"}
            className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:opacity-50 transition-colors"
            data-testid="retry-button"
          >
            {retryState === "retrying" ? "Retrying…" : "Retry analysis"}
          </button>
          {retryState === "error" && retryError && (
            <p className="mt-2 text-sm text-red-600" data-testid="retry-error">
              {retryError}
            </p>
          )}
        </div>
      )}

      {/* Result link — only shown when completed */}
      {run.overall === "completed" && (
        <div className="mb-5" data-testid="result-link-container">
          <Link
            href={`/runs/${runId}/result`}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 transition-colors"
            data-testid="result-link"
          >
            View Results
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
                clipRule="evenodd"
              />
            </svg>
          </Link>
        </div>
      )}

      {/* Stage list */}
      <div
        className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden"
        data-testid="stage-list"
      >
        {stages.map((stage, idx) => renderStage(stage, idx))}
      </div>
    </main>
  );
}
