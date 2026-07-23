import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { getFounderRuns } from "../../lib/api";
import DashboardList from "../../components/DashboardList";
import type { FounderRun } from "../../lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: { session } } = await supabase.auth.getSession();

  // TEMP DEBUG (revert once root cause found): distinguish empty-token from
  // real-token-rejected. If accessTokenPresent=false with userId set, the
  // dashboard hit the known Supabase SSR asymmetry: getUser() succeeded via
  // network but getSession() returned no cookie-derived session.
  console.log("[DashboardPage] pre-fetch auth state", {
    userId: user.id,
    accessTokenPresent: Boolean(session?.access_token),
    accessTokenLength: session?.access_token?.length ?? 0,
  });

  // TEMP DEBUG (revert once root cause found): surface underlying network error
  // instead of silently swallowing it.
  const sessionRes = await fetch(`${API_BASE}/auth/session`, {
    headers: { authorization: `Bearer ${session?.access_token ?? ""}` },
    cache: "no-store",
  }).catch((err) => {
    console.error("[DashboardPage] session fetch failed", {
      apiBase: API_BASE,
      url: `${API_BASE}/auth/session`,
      name: (err as Error)?.name,
      message: (err as Error)?.message,
      cause: (err as { cause?: unknown })?.cause,
      stack: (err as Error)?.stack,
    });
    return null;
  });

  // TEMP DEBUG (revert once root cause found): if the API responded but not
  // ok, log status + body so we know if it's 401 missing/invalid token, a
  // 5xx, or something else — instead of the generic banner.
  if (sessionRes && !sessionRes.ok) {
    const bodyText = await sessionRes
      .clone()
      .text()
      .catch(() => "<unreadable>");
    console.error("[DashboardPage] session fetch non-ok", {
      status: sessionRes.status,
      statusText: sessionRes.statusText,
      body: bodyText.slice(0, 500),
    });
  }

  const founderId = sessionRes?.ok
    ? ((await sessionRes.json()) as { founderId: string }).founderId
    : null;

  if (!founderId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Your Analyses</h1>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not connect to API — please ensure the API server is running.
        </div>
      </main>
    );
  }

  let runs: FounderRun[] = [];
  let error: string | null = null;

  try {
    runs = await getFounderRuns(founderId, session?.access_token ?? "");
  } catch (err) {
    console.error("[DashboardPage] failed to fetch runs:", err);
    error = (err as Error).message;
  }

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">
          Your Analyses
        </h1>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not load analyses — API unavailable.{" "}
          <span className="font-mono text-xs">{error}</span>
        </div>
      </main>
    );
  }

  return <DashboardList runs={runs} />;
}
