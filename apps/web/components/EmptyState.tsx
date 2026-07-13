"use client";

import Link from "next/link";

export default function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center py-24 px-6 text-center"
      data-testid="empty-state"
    >
      {/* Icon */}
      <div className="rounded-full bg-gray-100 p-5 mb-5">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-8 w-8 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          />
        </svg>
      </div>

      <h2 className="text-lg font-semibold text-gray-900">No analyses yet</h2>
      <p className="mt-2 text-sm text-gray-500 max-w-xs">
        You haven&apos;t requested a vertical analysis yet. Start one to see your
        results here.
      </p>

      {/* TODO: replace /intake with the real chat-intake route once built */}
      <Link
        href="/intake"
        className="mt-6 inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-colors"
        data-testid="empty-state-cta"
      >
        Start an Analysis
      </Link>
    </div>
  );
}
