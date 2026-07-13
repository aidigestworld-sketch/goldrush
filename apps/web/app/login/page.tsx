"use client";

import { useState } from "react";
import { createClient } from "../../lib/supabase/client";

type State = "idle" | "loading" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setState("loading");
    setErrorMessage(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setState("error");
      setErrorMessage(error.message);
    } else {
      setState("sent");
    }
  }

  if (state === "sent") {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen px-4">
        <div className="w-full max-w-sm text-center">
          <div className="rounded-full bg-green-100 p-4 inline-flex mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
              className="h-8 w-8 text-green-600" aria-hidden="true">
              <path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z" />
              <path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Check your email</h1>
          <p className="mt-2 text-sm text-gray-500">
            We sent a magic link to <span className="font-medium text-gray-700">{email}</span>.
            Click the link to sign in.
          </p>
          <button
            onClick={() => { setState("idle"); setEmail(""); }}
            className="mt-6 text-sm text-blue-600 hover:text-blue-800"
          >
            Use a different email
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Sign in</h1>
        <p className="text-sm text-gray-500 mb-8">
          Enter your email and we'll send you a magic link.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={state === "loading"}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
              data-testid="email-input"
            />
          </div>

          {state === "error" && (
            <p className="text-sm text-red-600" data-testid="login-error">
              {errorMessage ?? "Something went wrong. Please try again."}
            </p>
          )}

          <button
            type="submit"
            disabled={state === "loading" || !email.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="magic-link-button"
          >
            {state === "loading" ? "Sending…" : "Send magic link"}
          </button>
        </form>
      </div>
    </main>
  );
}
