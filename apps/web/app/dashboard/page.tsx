import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import DashboardClient from "./DashboardClient";

// TEMP WORKAROUND (revert once Railway support resolves the edge rate-limit;
// see Railway support ticket): API calls (/auth/session and /founders/:id/runs)
// were previously awaited here so the dashboard was fully server-rendered.
// Railway's edge is 429-blocking Vercel's server-runtime egress IPs, so those
// fetches now happen in the browser via ./DashboardClient. The auth gate
// (getUser + redirect to /login) stays server-side — it uses Supabase cookies,
// not Railway, and is unaffected by the rate limit.
//
// Once Railway lifts the block, revert both this file and DashboardClient.tsx
// together: put the fetches back here and render <DashboardList runs={runs} />
// directly. Server-side rendering is the better long-term architecture
// (no loading flash, no token in browser JS, faster first paint).
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return <DashboardClient />;
}
