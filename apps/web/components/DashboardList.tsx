"use client";

import Link from "next/link";
import type { FounderRun } from "../lib/api";
import RunCard from "./RunCard";
import EmptyState from "./EmptyState";
import { createClient } from "../lib/supabase/client";

interface Props {
  runs: FounderRun[];
}

// Pure rendering component — accepts pre-fetched runs as props so it can be
// tested in isolation without the Next.js server-component fetch machinery.
// The async data fetch lives in app/page.tsx.
export default function DashboardList({ runs }: Props) {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // Hard navigation (not router.push) to fully evict Next.js Router Cache.
    // router.push keeps prior segments cached, so signing in as a different
    // email in the same tab could flash the previous founder's dashboard
    // (or worse, a page whose auth state was captured under the prior user).
    // window.location.href = "/login" reloads the browser navigation stack
    // from scratch — middleware re-runs, cookies are re-read, Router Cache
    // starts empty.
    window.location.href = "/login";
  }

  // Header for the empty state — no "Start a new analysis" button here
  // because <EmptyState /> already renders its own primary CTA linking
  // to /intake (fresh-founder path: fill profile first, then checkout).
  const emptyStateHeader = (
    <div className="flex items-center justify-between mb-6">
      <h1 className="text-2xl font-semibold text-gray-900">Your Analyses</h1>
      <button
        onClick={handleSignOut}
        className="text-sm text-gray-500 hover:text-gray-700"
        data-testid="sign-out-button"
      >
        Sign out
      </button>
    </div>
  );

  // Header for the populated state — adds a primary "Start a new analysis"
  // button that skips straight to /vertical-request (returning-founder
  // path: intake is already done, go directly to vertical selection +
  // Stripe checkout). Deliberately labeled "Start a new analysis"
  // (not just "Retry" or "New") so it doesn't collide semantically with
  // the per-run "Retry analysis" button on RunStatusView — that one
  // re-uses the same runId and does NOT re-charge (POST /runs/:runId/retry).
  // This one creates a genuinely new run + payment.
  //
  // No schema/logic constraint against multiple runs per founder:
  // PipelineRun.founderId has no @unique, the webhook idempotency is
  // per Stripe session (unique to each checkout), and
  // GET /founders/:id/runs already returns ALL rows newest-first.
  const populatedStateHeader = (
    <div className="flex items-center justify-between mb-6 gap-4">
      <h1 className="text-2xl font-semibold text-gray-900">Your Analyses</h1>
      <div className="flex items-center gap-4">
        <Link
          href="/vertical-request"
          className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-colors"
          data-testid="new-analysis-button"
        >
          Start a new analysis
        </Link>
        <button
          onClick={handleSignOut}
          className="text-sm text-gray-500 hover:text-gray-700"
          data-testid="sign-out-button"
        >
          Sign out
        </button>
      </div>
    </div>
  );

  if (runs.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        {emptyStateHeader}
        <EmptyState />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {populatedStateHeader}
      <div className="flex flex-col gap-3" data-testid="run-list">

        {runs.map((run) => (
          <RunCard key={run.runId} run={run} />
        ))}
      </div>
    </main>
  );
}
