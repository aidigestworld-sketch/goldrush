"use client";

// TEMP WORKAROUND (revert once Railway support resolves the edge rate-limit;
// see Railway support ticket): the /auth/session and /founders/:id/runs
// fetches were server-rendered from apps/web/app/dashboard/page.tsx, which
// egressed from Vercel's shared Node-runtime IP ranges. Railway's edge
// (railway-hikari, ams1) is IP-rate-limiting those ranges with 429 while
// letting real user browser IPs through. Moving the calls into this
// "use client" component makes them originate from the visitor's own IP,
// bypassing the block until Railway lifts it.
//
// Long-term this should be reverted to server-side rendering — that avoids
// the loading flash, keeps tokens out of browser JS memory, and gives a
// faster first paint. This file (and the swap in page.tsx) should be
// deleted together as a single revert commit.

import { useEffect, useState } from "react";
import { createClient } from "../../lib/supabase/client";
import { getFounderRuns, type FounderRun } from "../../lib/api";
import DashboardList from "../../components/DashboardList";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

type State =
  | { kind: "loading" }
  | { kind: "session_error" }
  | { kind: "runs_error"; message: string }
  | { kind: "ready"; runs: FounderRun[] };

export default function DashboardClient() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";

      let founderId: string | null = null;
      try {
        const sessionRes = await fetch(`${API_BASE}/auth/session`, {
          headers: { authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (sessionRes.ok) {
          founderId = ((await sessionRes.json()) as { founderId: string }).founderId;
        }
      } catch {
        founderId = null;
      }

      if (cancelled) return;

      if (!founderId) {
        setState({ kind: "session_error" });
        return;
      }

      try {
        const runs = await getFounderRuns(founderId, token);
        if (cancelled) return;
        setState({ kind: "ready", runs });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: "runs_error", message: (err as Error).message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <main
        className="mx-auto max-w-3xl px-4 py-10"
        aria-busy="true"
        data-testid="dashboard-loading"
      >
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Your Analyses</h1>
        <div className="flex flex-col gap-3">
          <div className="h-24 rounded-md bg-gray-100 animate-pulse" />
          <div className="h-24 rounded-md bg-gray-100 animate-pulse" />
          <div className="h-24 rounded-md bg-gray-100 animate-pulse" />
        </div>
      </main>
    );
  }

  if (state.kind === "session_error") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Your Analyses</h1>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not connect to API — please ensure the API server is running.
        </div>
      </main>
    );
  }

  if (state.kind === "runs_error") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Your Analyses</h1>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not load analyses — API unavailable.{" "}
          <span className="font-mono text-xs">{state.message}</span>
        </div>
      </main>
    );
  }

  return <DashboardList runs={state.runs} />;
}
