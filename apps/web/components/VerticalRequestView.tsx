"use client";

import { useState } from "react";
import { createCheckoutSession } from "../lib/api";

// Vertical catalog shown in the form. Slugs MUST match the backend's
// ALLOWED_VERTICALS in apps/api/src/orchestrator/verticals.ts — if they
// drift, the /checkout endpoint 400s with a clear "unknown vertical" error.
// Each option's evidence pool must be pre-tagged with the same slug and a
// scoring_config row must exist per-vertical; discovery skips otherwise.
interface VerticalOption {
  slug: string;
  name: string;
  description: string;
}

const VERTICALS: VerticalOption[] = [
  {
    slug: "shopify_subscriptions",
    name: "Shopify Subscription Commerce",
    description:
      "Deep analysis of app opportunities in the Shopify subscription and reorder ecosystem — demand signals, competitor gaps, and founder-fit scoring.",
  },
  {
    slug: "b2b_customer_support_saas",
    name: "B2B Customer Support SaaS",
    description:
      "Opportunity scan across the B2B customer-support software space — help desks, ticketing, AI-assist tooling, and adjacent workflow gaps.",
  },
];

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
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [showCancelNotice, setShowCancelNotice] = useState(initialCanceled);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = VERTICALS.find((v) => v.slug === selectedSlug) ?? null;
  const canSubmit = selected != null && !loading;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const { url } = await createCheckoutSession(founderId, selected.slug, accessToken);
      window.location.href = url;
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="mx-auto w-full max-w-lg">
        {showCancelNotice && (
          <div
            className="mb-6 flex items-center gap-3 rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
            data-testid="cancel-notice"
          >
            <span className="flex-1">
              Payment canceled — you can try again whenever you&apos;re ready.
            </span>
            <button
              onClick={() => setShowCancelNotice(false)}
              className="shrink-0 font-medium text-yellow-600 hover:text-yellow-800"
              data-testid="dismiss-cancel-notice"
              aria-label="Dismiss"
              type="button"
            >
              ✕
            </button>
          </div>
        )}

        <h1 className="mb-1 text-xl font-semibold text-gray-900">Request a new analysis</h1>
        <p className="mb-6 text-sm text-gray-500">
          Pick a market and we&apos;ll spin up a full opportunity scan against your founder profile.
        </p>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
          data-testid="vertical-request-form"
        >
          <label htmlFor="vertical-select" className="block text-sm font-medium text-gray-900">
            Vertical
          </label>
          <select
            id="vertical-select"
            value={selectedSlug}
            onChange={(e) => setSelectedSlug(e.target.value)}
            disabled={loading}
            className="mt-1.5 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:cursor-not-allowed disabled:bg-gray-50"
            data-testid="vertical-select"
          >
            <option value="" disabled>
              Choose a vertical…
            </option>
            {VERTICALS.map((v) => (
              <option key={v.slug} value={v.slug}>
                {v.name}
              </option>
            ))}
          </select>

          {selected && (
            <p
              className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600"
              data-testid="vertical-description"
            >
              {selected.description}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-5 w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="start-analysis-button"
          >
            {loading ? "Preparing checkout…" : `Start analysis — ${priceDisplay}`}
          </button>

          {error && (
            <p className="mt-3 text-sm text-red-600" data-testid="checkout-error">
              {error}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
