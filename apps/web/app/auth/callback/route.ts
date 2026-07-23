import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Ask the API whether a founder row already exists for this Supabase user.
  // The API verifies the JWT and returns { founderId: string | null }.
  // Step 5 adds the INSERT so new users get a founder row before /intake loads.
  const sessionRes = await fetch(`${API_BASE}/auth/session`, {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  }).catch(() => null);

  // If the API is unreachable, fall back to /dashboard — the session IS valid
  // and the dashboard's own error state handles the API-down case. Never
  // redirect to /login with a valid session: middleware would bounce back.
  const isNew = sessionRes?.ok
    ? ((await sessionRes.json()) as { founderId: string; isNew: boolean }).isNew
    : false;

  return NextResponse.redirect(`${origin}${isNew ? "/intake" : "/dashboard"}`);
}
