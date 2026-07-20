"use client";

import Link from "next/link";
import type { RunResult } from "../lib/api";
import { formatVertical } from "./RunCard";

function ScoreChip({
  label,
  value,
  testId,
}: {
  label: string;
  value: number | null;
  testId: string;
}) {
  return (
    <div
      className="flex flex-col items-center rounded-lg border border-gray-200 bg-white px-4 py-3 shadow-sm"
      data-testid={testId}
    >
      <span className="text-xl font-bold tabular-nums text-gray-900">
        {value == null ? "—" : `${Math.round(value * 100)}%`}
      </span>
      <span className="mt-0.5 text-xs text-gray-500">{label}</span>
    </div>
  );
}

// Human-readable translation of compression's deprecationReason strings.
// See src/agents/compression.ts (backend) for the source of these values.
function explainDeprecation(reason: string | null): string | null {
  switch (reason) {
    case "failed_gate":
      return "Founder-fit fell below the minimum threshold required for promotion";
    case "lost_tiebreak":
      return "Ranked below another candidate in the tiebreak";
    case "incomplete_composition":
      return "Missing required composition slots — not all roles were filled";
    default:
      return reason;
  }
}

interface Props {
  result: RunResult;
  runId: string;
}

export default function RunResultView({ result, runId }: Props) {
  const { vertical, opportunity, candidates } = result;
  // "Evaluated but not promoted": no winner AND at least one candidate row
  // exists in the run. Distinguished from the "no candidates ever composed"
  // case (empty candidates[]) so we can show real scored detail versus a
  // simpler honest message.
  const evaluatedNotPromoted = opportunity === null && candidates.length > 0;
  const noCandidatesEver = opportunity === null && candidates.length === 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10" data-testid="run-result-view">
      <Link
        href={`/runs/${runId}`}
        className="mb-8 inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← Back to status
      </Link>

      {evaluatedNotPromoted ? (
        <div className="mt-2" data-testid="evaluated-not-promoted-state">
          <div className="mb-8">
            <h1 className="text-2xl font-bold leading-snug text-gray-900" data-testid="not-promoted-headline">
              No opportunity cleared the bar
            </h1>
            {vertical && (
              <p className="mt-1 text-sm text-gray-500">{formatVertical(vertical)}</p>
            )}
            <p className="mt-3 max-w-2xl text-sm text-gray-600">
              We evaluated {candidates.length === 1 ? "one candidate" : `${candidates.length} candidates`} for this run.
              Below is the scored detail and rationale for each — none were promoted, but the analysis produced real evidence you can act on.
            </p>
          </div>

          <div className="space-y-8" data-testid="candidates-list">
            {candidates.map((c, i) => {
              const reason = explainDeprecation(c.deprecationReason);
              return (
                <section
                  key={c.id}
                  className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
                  data-testid={`candidate-card-${i}`}
                >
                  <div className="mb-4 grid grid-cols-3 gap-3" data-testid={`candidate-scores-${i}`}>
                    <ScoreChip label="Quality" value={c.opportunityQuality} testId={`candidate-${i}-score-quality`} />
                    <ScoreChip label="Confidence" value={c.confidenceScore} testId={`candidate-${i}-score-confidence`} />
                    <ScoreChip label="Founder Fit" value={c.founderFitScore} testId={`candidate-${i}-score-founder-fit`} />
                  </div>

                  {c.ventureScore === null && reason && (
                    <div
                      className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                      data-testid={`candidate-${i}-gate-reason`}
                    >
                      <span className="font-semibold">Not promoted:</span> {reason}
                    </div>
                  )}

                  {c.founderFitRationale && (
                    <div data-testid={`candidate-${i}-founder-fit-rationale`}>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">
                        Founder-fit rationale
                      </h3>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                        {c.founderFitRationale}
                      </p>
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          <Link
            href={`/runs/${runId}`}
            className="mt-8 inline-block text-sm text-blue-600 hover:underline"
            data-testid="back-to-status-link"
          >
            View analysis steps →
          </Link>
        </div>
      ) : noCandidatesEver ? (
        <div
          className="mt-6 rounded-xl border border-gray-200 bg-white p-10 text-center shadow-sm"
          data-testid="no-opportunity-state"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              className="h-6 w-6 text-gray-400"
              aria-hidden="true"
            >
              <path
                d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">No scorable opportunity identified</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-gray-500">
            The available evidence for {vertical ? formatVertical(vertical) : "this vertical"} didn&apos;t
            support composing a candidate to score. Try refining your inputs or running again after new evidence lands.
          </p>
          <Link
            href={`/runs/${runId}`}
            className="mt-5 inline-block text-sm text-blue-600 hover:underline"
            data-testid="back-to-status-link"
          >
            View analysis steps →
          </Link>
        </div>
      ) : opportunity ? (
        <div className="mt-2">
          {/* Document header */}
          <div className="mb-8">
            <h1
              className="text-2xl font-bold leading-snug text-gray-900"
              data-testid="opportunity-headline"
            >
              {opportunity.rationaleBullets[0] ?? "Analysis Complete"}
            </h1>
            {vertical && (
              <p className="mt-1 text-sm text-gray-500">{formatVertical(vertical)}</p>
            )}
          </div>

          {/* Score row */}
          <div className="mb-10 grid grid-cols-3 gap-3" data-testid="score-row">
            <ScoreChip
              label="Venture"
              value={opportunity.ventureScore}
              testId="score-chip-venture"
            />
            <ScoreChip
              label="Confidence"
              value={opportunity.confidenceScore}
              testId="score-chip-confidence"
            />
            <ScoreChip
              label="Founder Fit"
              value={opportunity.founderFitScore}
              testId="score-chip-founder-fit"
            />
          </div>

          {/* Why this opportunity — omit entirely when OpportunityRationale
              hasn't populated bullets, to avoid rendering an empty header. */}
          {opportunity.rationaleBullets.length > 0 && (
            <section className="mb-10" data-testid="rationale-section">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
                Why this opportunity
              </h2>
              <ul className="space-y-3">
                {opportunity.rationaleBullets.map((bullet, i) => (
                  <li
                    key={i}
                    className="flex gap-3 text-sm leading-relaxed text-gray-800"
                    data-testid={`rationale-bullet-${i}`}
                  >
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500"
                      aria-hidden="true"
                    />
                    {bullet}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Founder fit rationale — shown only when present */}
          {opportunity.founderFitRationale && (
            <section className="mb-10" data-testid="founder-fit-rationale">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
                Founder fit
              </h2>
              <p className="text-sm leading-relaxed text-gray-800">
                {opportunity.founderFitRationale}
              </p>
            </section>
          )}

          {/* Risks & gaps — omit entirely when OpportunityRationale hasn't
              populated the summary, to avoid rendering an empty header. */}
          {opportunity.riskSummary.length > 0 && (
            <section data-testid="risk-section">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">
                Risks &amp; gaps
              </h2>
              <ul className="space-y-3">
                {opportunity.riskSummary.map((risk, i) => (
                  <li
                    key={i}
                    className="flex gap-3 text-sm leading-relaxed text-gray-800"
                    data-testid={`risk-bullet-${i}`}
                  >
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                      aria-hidden="true"
                    />
                    {risk}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}
    </main>
  );
}
