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
  return overall === "completed" || overall === "failed" || overall === "insufficient_evidence";
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

// After this many consecutive poll failures we surface a "having trouble
// checking status" indicator to the user. 3 is roughly 12 s of failed
// checks at the default 4 s interval — long enough that a single
// hiccup doesn't spook the user, short enough that a real outage
// (server down, auth expired, network gone) becomes visible before the
// user gives up and refreshes.
const POLL_FAILURE_SURFACE_THRESHOLD = 3;

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
  // Tracks consecutive poll failures. Reset on success. When it crosses
  // POLL_FAILURE_SURFACE_THRESHOLD we render the indicator below.
  const [pollFailureCount, setPollFailureCount] = useState(0);

  async function handleRetry() {
    setRetryState("retrying");
    setRetryError(null);
    try {
      await retryRun(runId, accessToken);
      // Forward accessToken to the follow-up status fetch too — the
      // API middleware requires a Bearer header on /runs/:id/status
      // exactly as it does on /runs/:id/retry. Omitting it here was
      // the 401 the retry banner surfaced on 2026-07-16.
      const fresh = await getRunStatus(runId, accessToken);
      setData(fresh);
      setRetryState("idle");
    } catch (err) {
      setRetryError((err as Error).message);
      setRetryState("error");
    }
  }

  // Clear a stale retry error whenever the overall status changes — e.g.
  // the user hit retry too early ("run status is 'running'"), the run later
  // transitioned to 'failed' via polling, and the old error banner is stale.
  useEffect(() => {
    setRetryState("idle");
    setRetryError(null);
  }, [data.run.overall]);

  // Poll while the run is not yet in a terminal state. React's effect
  // cleanup clears the interval; when data.run.overall changes to a
  // terminal value the effect re-runs, returns early, and no new interval
  // is set.
  useEffect(() => {
    if (isTerminal(data.run.overall)) return;

    const id = setInterval(async () => {
      try {
        // Same accessToken fix as handleRetry: without the Bearer
        // header the API returns 401 every tick. That 401 used to be
        // eaten silently by the empty catch below and was invisible
        // in devtools — the visible symptom was the retry click's
        // follow-up status fetch, not the ongoing poll.
        const fresh = await getRunStatus(runId, accessToken);
        setData(fresh);
        setPollFailureCount(0);
      } catch (err) {
        // Log so genuine persistent failures (auth expired, server
        // down) are visible in devtools instead of looking identical
        // to "still processing" from the user's perspective. We keep
        // the last-known state on screen for transient hiccups, but
        // surface an indicator once failures cross a threshold.
        console.error(`[RunStatusView] poll failed for run ${runId}:`, err);
        setPollFailureCount((n) => n + 1);
      }
    }, pollIntervalMs);

    return () => clearInterval(id);
  }, [data.run.overall, runId, pollIntervalMs, accessToken]);

  const { run, stages } = data;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10" data-testid="run-status-view">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard"
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
                {/* Explicit "en-US" locale — passing undefined resolves to
                    the runtime's default which differs server-side (Next.js
                    SSR uses the OS locale) vs client-side (browser locale),
                    producing a hydration mismatch when the visitor's browser
                    isn't en-US. Consistent locale on both sides keeps SSR
                    output byte-identical to the first client render. */}
                {new Date(run.startedAt).toLocaleDateString("en-US", {
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

      {/* Poll-failure indicator — shows only once consecutive failures
          cross the threshold, so a single hiccup doesn't spook the user.
          Auto-clears on the next successful poll (pollFailureCount reset to 0). */}
      {!isTerminal(run.overall) && pollFailureCount >= POLL_FAILURE_SURFACE_THRESHOLD && (
        <div
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="poll-failure-indicator"
        >
          Having trouble checking status, retrying…
        </div>
      )}

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

      {/* Result link — shown for any terminal state that produced a result
          page: a completed run (winner promoted) OR an insufficient_evidence
          run (candidates evaluated but none passed the gate — the result
          page renders the per-candidate detail). */}
      {(run.overall === "completed" || run.overall === "insufficient_evidence") && (
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
