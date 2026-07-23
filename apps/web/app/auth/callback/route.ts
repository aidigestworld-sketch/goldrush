import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  // TEMP DEBUG: log incoming request shape to diagnose magic-link loop. REMOVE ONCE ROOT CAUSE FOUND.
  console.log("[TEMP DEBUG /auth/callback] incoming", {
    host: request.headers.get("host"),
    xForwardedHost: request.headers.get("x-forwarded-host"),
    xForwardedProto: request.headers.get("x-forwarded-proto"),
    url: request.url,
    origin,
    hasCode: !!code,
    codeLength: code?.length ?? 0,
    allSearchParamKeys: Array.from(searchParams.keys()),
  });

  if (!code) {
    // TEMP DEBUG: REMOVE
    console.log("[TEMP DEBUG /auth/callback] no code param — redirecting to /login?error=auth_failed");
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const cookieStore = await cookies();

  // TEMP DEBUG: log cookie names present before PKCE exchange. Names only, no values. REMOVE.
  const cookieNames = cookieStore.getAll().map((c) => c.name);
  console.log("[TEMP DEBUG /auth/callback] cookies before exchange", {
    totalCount: cookieNames.length,
    allNames: cookieNames,
    pkceRelated: cookieNames.filter((n) =>
      /code-verifier|auth-token|pkce/i.test(n)
    ),
    supabaseRelated: cookieNames.filter((n) => n.startsWith("sb-")),
  });

  // TEMP DEBUG: track every setAll invocation from Supabase during exchange. REMOVE.
  const setAllInvocations: Array<{
    count: number;
    names: string[];
    options: Array<Record<string, unknown>>;
  }> = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // TEMP DEBUG: capture what Supabase asked to write (names+options only, NO values). REMOVE.
          setAllInvocations.push({
            count: cookiesToSet.length,
            names: cookiesToSet.map((c) => c.name),
            options: cookiesToSet.map((c) => ({
              secure: c.options?.secure,
              httpOnly: c.options?.httpOnly,
              sameSite: c.options?.sameSite,
              domain: c.options?.domain,
              path: c.options?.path,
              maxAge: c.options?.maxAge,
              expires: c.options?.expires ? String(c.options.expires) : undefined,
            })),
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    // TEMP DEBUG: log the full failure shape. REMOVE.
    console.log("[TEMP DEBUG /auth/callback] exchangeCodeForSession FAILED", {
      hasError: !!error,
      hasSession: !!data?.session,
      errorName: error?.name,
      errorMessage: error?.message,
      errorStatus: (error as unknown as { status?: number })?.status,
      errorCode: (error as unknown as { code?: string })?.code,
      errorFull: error
        ? JSON.stringify(error, Object.getOwnPropertyNames(error))
        : null,
    });
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // TEMP DEBUG: REMOVE
  console.log("[TEMP DEBUG /auth/callback] exchangeCodeForSession SUCCESS", {
    userId: data.session.user?.id,
    hasAccessToken: !!data.session.access_token,
    expiresAt: data.session.expires_at,
    setAllInvocationCount: setAllInvocations.length,
    setAllInvocations,
  });

  // TEMP DEBUG: read cookieStore AFTER exchange to see what Next.js recorded. REMOVE.
  const cookiesAfterExchange = cookieStore.getAll().map((c) => c.name);
  console.log("[TEMP DEBUG /auth/callback] cookieStore state after exchange", {
    totalCount: cookiesAfterExchange.length,
    allNames: cookiesAfterExchange,
    supabaseRelated: cookiesAfterExchange.filter((n) => n.startsWith("sb-")),
  });

  // Ask the API whether a founder row already exists for this Supabase user.
  // The API verifies the JWT and returns { founderId: string | null }.
  // Step 5 adds the INSERT so new users get a founder row before /intake loads.
  const sessionRes = await fetch(`${API_BASE}/auth/session`, {
    headers: { authorization: `Bearer ${data.session.access_token}` },
  }).catch(() => null);

  // If the API is unreachable, fall back to "/" — the session IS valid and the
  // page-level error state handles the API-down case. Never redirect to /login
  // with a valid session: middleware would immediately bounce back to /, looping.
  const isNew = sessionRes?.ok
    ? ((await sessionRes.json()) as { founderId: string; isNew: boolean }).isNew
    : false;

  const redirectTarget = `${origin}${isNew ? "/intake" : "/"}`;
  // TEMP DEBUG: confirm origin used for the final redirect. REMOVE.
  console.log("[TEMP DEBUG /auth/callback] redirecting after success", {
    origin,
    isNew,
    target: redirectTarget,
    sessionApiOk: sessionRes?.ok ?? false,
    sessionApiStatus: sessionRes?.status ?? null,
  });
  return NextResponse.redirect(redirectTarget);
}
