import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import VerticalRequestView from "../../components/VerticalRequestView";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

interface Props {
  searchParams: Promise<{ canceled?: string }>;
}

export default async function VerticalRequestPage({ searchParams }: Props) {
  const { canceled } = await searchParams;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token ?? "";

  const sessionRes = await fetch(`${API_BASE}/auth/session`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  }).catch(() => null);

  const sessionBody = sessionRes?.ok
    ? ((await sessionRes.json()) as { founderId: string; intakeComplete?: boolean })
    : null;

  if (!sessionBody?.founderId) redirect("/login");

  // Gate: this page is the "post-intake, request-a-run" step. A founder who
  // hasn't finished intake has no FounderProfile signal for FounderFit and
  // shouldn't be able to spend money on a run whose scoring would be starved.
  // /auth/session derives intakeComplete from founder.intakeState.completedAt.
  if (!sessionBody.intakeComplete) redirect("/intake");

  const founderId = sessionBody.founderId;

  // Fetch the real price from the backend so the button label stays in sync
  // with the Stripe price without requiring a frontend deploy when it changes.
  let priceDisplay = "Get started";
  try {
    const priceRes = await fetch(`${API_BASE}/stripe/price`, { cache: "no-store" });
    if (priceRes.ok) {
      const { unitAmount, currency } = (await priceRes.json()) as {
        unitAmount: number | null;
        currency: string;
      };
      if (unitAmount != null) {
        priceDisplay =
          currency === "usd"
            ? `$${(unitAmount / 100).toFixed(0)}`
            : `${currency.toUpperCase()} ${(unitAmount / 100).toFixed(0)}`;
      }
    }
  } catch {
    // Non-critical — fall back to generic label; the Stripe checkout will still work.
  }

  return (
    <VerticalRequestView
      founderId={founderId}
      accessToken={accessToken}
      priceDisplay={priceDisplay}
      initialCanceled={canceled === "true"}
    />
  );
}
