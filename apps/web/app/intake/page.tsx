import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import IntakeChat from "../../components/IntakeChat";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export default async function IntakePage() {
  const supabase = await createClient();
  // getUser() validates the JWT server-side; getSession() does not.
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: { session } } = await supabase.auth.getSession();

  const sessionRes = await fetch(`${API_BASE}/auth/session`, {
    headers: { authorization: `Bearer ${session?.access_token ?? ""}` },
    cache: "no-store",
  }).catch(() => null);

  const founderId = sessionRes?.ok
    ? ((await sessionRes.json()) as { founderId: string }).founderId
    : null;

  if (!founderId) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Could not connect to API — please ensure the API server is running.
        </div>
      </main>
    );
  }

  return <IntakeChat founderId={founderId} />;
}
