"use client";

import { useState } from "react";
import { createCheckoutSession } from "../lib/api";

// The only vertical available today. Internal key kept out of user-facing copy.
const VERTICAL_KEY = "shopify_subscriptions";

interface Props {
  founderId: string;
  accessToken: string;
  /** Display string for the price, e.g. "$49". Fetched server-side from Stripe. */
  priceDisplay: string;
  /** True when the user returned from Stripe with ?canceled=true. */
  initialCanceled?: boolean;
}

export default function VerticalRequestView({
  founderId,
  accessToken,
  priceDisplay,
  initialCanceled = false,
}: Props) {
  const [showCancelNotice, setShowCancelNotice] = useState(initialCanceled);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartAnalysis() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await createCheckoutSession(founderId, VERTICAL_KEY, accessToken);
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-col items-center justify-center min-h-screen px-4">
      {showCancelNotice && (
        <div
          className="mb-6 flex items-center gap-3 rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 w-full max-w-md"
          data-testid="cancel-notice"
        >
          <span className="flex-1">Payment canceled — you can try again whenever you&apos;re ready.</span>
          <button
            onClick={() => setShowCancelNotice(false)}
            className="text-yellow-600 hover:text-yellow-800 font-medium shrink-0"
            data-testid="dismiss-cancel-notice"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Choose a vertical</h1>
        <p className="text-sm text-gray-500 mb-6">Select the market to analyse.</p>

        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-gray-900">Shopify Subscription Commerce</h2>
          <p
            className="mt-1 text-sm text-gray-500"
            data-testid="vertical-description"
          >
            Deep analysis of app opportunities in the Shopify subscription and
            reorder ecosystem — demand signals, competitor gaps, and founder-fit
            scoring.
          </p>

          <div className="mt-5 flex flex-col gap-3">
            <button
              onClick={handleStartAnalysis}
              disabled={loading}
              className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
              data-testid="start-analysis-button"
            >
              {loading ? "Preparing checkout…" : `Start analysis — ${priceDisplay}`}
            </button>

            {error && (
              <p
                className="text-sm text-red-600"
                data-testid="checkout-error"
              >
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
