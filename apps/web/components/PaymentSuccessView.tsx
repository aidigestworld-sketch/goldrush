"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCheckoutStatus } from "../lib/api";

export const DEFAULT_POLL_INTERVAL_MS = 1500;
export const DEFAULT_POLL_TIMEOUT_MS = 20000;

type PollState = "polling" | "redirecting" | "timeout" | "not_paid";

interface Props {
  founderId: string;
  sessionId: string;
  accessToken: string;
  /** Override for tests. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export default function PaymentSuccessView({
  founderId,
  sessionId,
  accessToken,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
}: Props) {
  const router = useRouter();
  const [state, setState] = useState<PollState>("polling");
  const [paidConfirmed, setPaidConfirmed] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setState("not_paid");
      return;
    }

    let cancelled = false;
    const startTime = Date.now();
    let timerId: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      try {
        const status = await getCheckoutStatus(founderId, sessionId, accessToken);
        if (cancelled) return;

        if (!status.paid) {
          setState("not_paid");
          return;
        }

        setPaidConfirmed(true);

        if (status.runId) {
          setState("redirecting");
          router.push(`/runs/${status.runId}`);
          return;
        }

        // paid but webhook hasn't created the run yet — keep polling or time out
        if (Date.now() - startTime >= pollTimeoutMs) {
          setState("timeout");
          return;
        }
        timerId = setTimeout(poll, pollIntervalMs);
      } catch {
        if (cancelled) return;
        if (Date.now() - startTime >= pollTimeoutMs) {
          setState("timeout");
          return;
        }
        timerId = setTimeout(poll, pollIntervalMs);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timerId);
    };
  }, [founderId, sessionId, accessToken, pollIntervalMs, pollTimeoutMs, router]);

  if (state === "not_paid") {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen px-4" data-testid="not-paid-state">
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Payment not confirmed</h1>
          <p className="text-sm text-gray-500">
            We couldn&apos;t confirm your payment. If you believe you were charged,
            please contact support.
          </p>
        </div>
      </main>
    );
  }

  if (state === "timeout") {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen px-4" data-testid="timeout-state">
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            {paidConfirmed ? "Payment received — starting your analysis" : "Taking a moment…"}
          </h1>
          <p className="text-sm text-gray-500 mb-5">
            {paidConfirmed
              ? "Your payment went through but the analysis is taking a moment to start. Use the button below to check again."
              : "Something took longer than expected. Refresh to check the latest status."}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
            data-testid="refresh-button"
          >
            Refresh
          </button>
        </div>
      </main>
    );
  }

  // "polling" or "redirecting" — show the same loading state
  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-4" data-testid="confirming-payment">
      <div className="w-full max-w-md text-center">
        <div
          className="mx-auto mb-4 h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900"
          aria-hidden="true"
        />
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Confirming your payment…</h1>
        <p className="text-sm text-gray-500">
          Setting up your analysis. This usually takes just a moment.
        </p>
      </div>
    </main>
  );
}
