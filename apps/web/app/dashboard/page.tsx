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

  // TEMP DEBUG: probe Vercel→Railway edge behavior (429 IP-scoping hypothesis)
  console.log("[TEMP DEBUG dashboard] API_BASE=", API_BASE, "hasToken=", Boolean(session?.access_token));
  let sessionRes: Response | null = null;
  let sessionThrew: unknown = null;
  try {
    sessionRes = await fetch(`${API_BASE}/auth/session`, {
      headers: { authorization: `Bearer ${session?.access_token ?? ""}` },
      cache: "no-store",
    });
  } catch (err) {
    sessionThrew = err;
  }
  if (sessionThrew) {
    console.log("[TEMP DEBUG dashboard] /auth/session FETCH THREW:", String(sessionThrew));
  } else if (sessionRes) {
    const bodyText = await sessionRes.clone().text().catch(() => "<body read failed>");
    console.log(
      "[TEMP DEBUG dashboard] /auth/session status=", sessionRes.status,
      "server=", sessionRes.headers.get("server"),
      "x-railway-edge=", sessionRes.headers.get("x-railway-edge"),
      "x-hikari-trace=", sessionRes.headers.get("x-hikari-trace"),
      "body=", bodyText.slice(0, 300),
    );
  }
  // END TEMP DEBUG

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
    // TEMP DEBUG: log founderId presence before calling
    console.log("[TEMP DEBUG dashboard] calling getFounderRuns founderId=", founderId);
    runs = await getFounderRuns(founderId, session?.access_token ?? "");
    console.log("[TEMP DEBUG dashboard] getFounderRuns returned count=", runs.length);
  } catch (err) {
    console.error("[DashboardPage] failed to fetch runs:", err);
    // TEMP DEBUG: expose full error shape
    console.log("[TEMP DEBUG dashboard] getFounderRuns THREW:", String(err));
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
