"use client";

import { useState, type FormEvent } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = "idle" | "submitting" | "success" | "error";

export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "submitting") return;

    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setErrorMessage("Please enter a valid email address.");
      setStatus("error");
      return;
    }

    setStatus("submitting");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, website }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMessage(
          body.error === "invalid_email"
            ? "Please enter a valid email address."
            : "Something went wrong. Please try again."
        );
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div
        className="gr-waitlist-success"
        data-testid="waitlist-success"
        role="status"
      >
        <span className="gr-waitlist-success-mark" aria-hidden="true">✓</span>
        You&rsquo;re on the list. We&rsquo;ll be in touch.
      </div>
    );
  }

  return (
    <form
      className="gr-waitlist-form"
      data-testid="waitlist-form"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="gr-waitlist-row">
        <input
          type="email"
          name="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") {
              setStatus("idle");
              setErrorMessage(null);
            }
          }}
          placeholder="you@company.com"
          aria-label="Email address"
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "waitlist-error" : undefined}
          className="gr-waitlist-input"
          data-testid="waitlist-email-input"
          disabled={status === "submitting"}
          required
        />
        {/* Honeypot: hidden from real users but visible to naive bots.
            A non-empty value causes the server to no-op silently. */}
        <input
          type="text"
          name="website"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="gr-waitlist-hp"
          data-testid="waitlist-honeypot"
        />
        <button
          type="submit"
          className="gr-cta-primary gr-waitlist-submit"
          data-testid="waitlist-submit"
          disabled={status === "submitting" || email.trim().length === 0}
        >
          {status === "submitting" ? "Joining…" : "Join waitlist"}
          {status !== "submitting" && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M3 8H13M13 8L9 4M13 8L9 12"
                stroke="#17110a"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      </div>
      {status === "error" && errorMessage && (
        <p
          id="waitlist-error"
          className="gr-waitlist-error"
          data-testid="waitlist-error"
          role="alert"
        >
          {errorMessage}
        </p>
      )}
    </form>
  );
}
