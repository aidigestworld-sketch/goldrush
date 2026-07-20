import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

// Kept in sync with the client-side check in WaitlistForm.tsx; the server
// re-validates because the client is untrusted (curl, replay, etc.).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type WaitlistBody = {
  email?: unknown;
  // Honeypot: the visible form doesn't render this field, so any non-empty
  // value here is a bot filling every input it sees. We ack with 200 so
  // the bot can't distinguish accepted vs rejected.
  website?: unknown;
};

export async function POST(request: Request) {
  let body: WaitlistBody;
  try {
    body = (await request.json()) as WaitlistBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.website === "string" && body.website.length > 0) {
    return NextResponse.json({ ok: true });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("waitlist_signups")
    .insert({ email, source: "landing" });

  // Postgres unique_violation. Treat as success so we don't leak which
  // emails are already on the list.
  if (error && error.code !== "23505") {
    // Log the real Supabase error so we don't stare at a silent 500 next
    // time a migration ships without being applied, or an RLS policy
    // regresses. The response stays generic on purpose.
    console.error(
      "[waitlist] insert failed",
      JSON.stringify({
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      })
    );
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
