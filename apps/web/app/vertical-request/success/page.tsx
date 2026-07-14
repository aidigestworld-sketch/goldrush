import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import PaymentSuccessView from "../../../components/PaymentSuccessView";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface Props {
  searchParams: Promise<{ session_id?: string }>;
}

export default async function PaymentSuccessPage({ searchParams }: Props) {
  const { session_id } = await searchParams;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token ?? "";

  const sessionRes = await fetch(`${API_BASE}/auth/session`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  }).catch(() => null);

  const founderId = sessionRes?.ok
    ? ((await sessionRes.json()) as { founderId: string }).founderId
    : null;

  if (!founderId) redirect("/login");

  // session_id is required — Stripe always appends it to the success_url.
  // If it's missing the user navigated here directly; send them to the payment page.
  if (!session_id) redirect("/vertical-request");

  return (
    <PaymentSuccessView
      founderId={founderId}
      sessionId={session_id}
      accessToken={accessToken}
    />
  );
}
