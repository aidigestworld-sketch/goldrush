import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Paths that do not require a session. Everything else is protected by default.
// "/" is the public marketing landing page — separate from the authenticated
// dashboard, which lives at "/dashboard".
const PUBLIC_PATHS = new Set(["/", "/login", "/auth/callback"]);

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  // TEMP DEBUG: only for a small allowlist of paths to avoid noise. REMOVE.
  const debugPaths = new Set(["/", "/login", "/dashboard", "/intake"]);
  const debugPath = request.nextUrl.pathname;
  const shouldDebug = debugPaths.has(debugPath);

  // TEMP DEBUG: track cookies observed / set in middleware. REMOVE.
  let middlewareSetAllInvocations = 0;
  const middlewareSetAllNames: string[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          middlewareSetAllInvocations += 1;
          cookiesToSet.forEach((c) => middlewareSetAllNames.push(c.name));
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // TEMP DEBUG: log incoming request cookie state before getUser. REMOVE.
  if (shouldDebug) {
    const incomingCookieNames = request.cookies.getAll().map((c) => c.name);
    console.log("[TEMP DEBUG middleware] incoming", {
      path: debugPath,
      host: request.headers.get("host"),
      xForwardedHost: request.headers.get("x-forwarded-host"),
      totalCookieCount: incomingCookieNames.length,
      allCookieNames: incomingCookieNames,
      supabaseRelated: incomingCookieNames.filter((n) => n.startsWith("sb-")),
    });
  }

  // IMPORTANT: do not add logic between createServerClient and getUser().
  // A stale session would otherwise silently pass through unrefreshed.
  const { data: { user }, error: getUserError } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // TEMP DEBUG: log getUser outcome + branch decision. REMOVE.
  if (shouldDebug) {
    console.log("[TEMP DEBUG middleware] getUser result", {
      path: pathname,
      hasUser: !!user,
      userId: user?.id ?? null,
      getUserErrorName: getUserError?.name,
      getUserErrorMessage: getUserError?.message,
      getUserErrorStatus: (getUserError as unknown as { status?: number })
        ?.status,
      middlewareSetAllInvocations,
      middlewareSetAllNames,
    });
  }

  if (!user && !PUBLIC_PATHS.has(pathname)) {
    // TEMP DEBUG: REMOVE
    if (shouldDebug) {
      console.log("[TEMP DEBUG middleware] BRANCH: unauth on non-public — redirecting to /login", {
        path: pathname,
      });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    // TEMP DEBUG: REMOVE
    if (shouldDebug) {
      console.log("[TEMP DEBUG middleware] BRANCH: auth on /login — redirecting to /dashboard");
    }
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    const res = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((c) => res.cookies.set(c));
    return res;
  }

  // TEMP DEBUG: REMOVE
  if (shouldDebug) {
    console.log("[TEMP DEBUG middleware] BRANCH: pass-through", {
      path: pathname,
      hasUser: !!user,
    });
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
