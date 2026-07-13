"use client";

import { useRouter } from "next/navigation";
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
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const header = (
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

  if (runs.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        {header}
        <EmptyState />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {header}
      <div className="flex flex-col gap-3" data-testid="run-list">

        {runs.map((run) => (
          <RunCard key={run.runId} run={run} />
        ))}
      </div>
    </main>
  );
}
