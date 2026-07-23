// Typed fetch wrapper for the Opportunity Engine Express API.
//
// Base URL is read from NEXT_PUBLIC_API_URL (set in .env.local).
// Falls back to http://localhost:3000 for local development where the
// Express server runs on its default port.
//
// All functions throw on non-2xx responses so callers can handle errors
// consistently (Next.js error boundaries or try/catch in server components).

const API_BASE =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL
    ? process.env.NEXT_PUBLIC_API_URL
    : "http://localhost:3000";

// "insufficient_evidence" surfaces the empty-cascade terminal outcome
// (Discovery skipped because no evidence for this vertical, cascading
// through every downstream step until Compression writes
// pipeline_run.status='insufficient_evidence'). Kept distinct from
// "completed" so a run that produced no Opportunity doesn't render
// identically to one that did — see StatusBadge and emptyCascadeStatus.test.ts.
export type RunOverallStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "insufficient_evidence"
  | "failed";

export interface RunOpportunity {
  ventureScore: number;
  confidenceScore: number;
  founderFitScore: number;
  /** rationaleBullets[0] from the promoted Opportunity row — null if no bullets stored. */
  headline: string | null;
}

export interface FounderRun {
  runId: string;
  /** Raw vertical enum string, e.g. "shopify_subscriptions". */
  vertical: string;
  /** ISO 8601 timestamp — createdAt = pipeline_run.started_at. */
  createdAt: string;
  overall: RunOverallStatus;
  /** null when the run hasn't produced a promoted Opportunity yet. */
  opportunity: RunOpportunity | null;
}

// ── Run status (status view) ───────────────────────────────────────────────

/** Mirrors the CheckpointStatus enum + "not_started" for steps with no row yet. */
export type StepStatus =
  | "not_started"
  | "pending"
  | "running"
  | "succeeded"
  | "failed_permanent";

export interface StepInfo {
  step: string;
  label: string;
  status: StepStatus;
  attemptCount: number;
  lastError: string | null;
  /** ISO 8601 or null */
  startedAt: string | null;
  /** ISO 8601 or null */
  completedAt: string | null;
}

/** Discriminated union matching the server's buildStages() output. */
export type Stage =
  | ({ type: "step" } & StepInfo)
  | { type: "fork"; branches: StepInfo[] };

export interface RunStatus {
  run: {
    runId: string;
    hypothesisId: string | null;
    vertical: string | null;
    startedAt: string | null;
    overall: RunOverallStatus;
  };
  stages: Stage[];
}

export async function getRunStatus(runId: string, accessToken?: string): Promise<RunStatus> {
  const res = await fetch(`${API_BASE}/runs/${runId}/status`, {
    cache: "no-store",
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (!res.ok) {
    throw new Error(`GET /runs/${runId}/status failed with status ${res.status}`);
  }
  return res.json() as Promise<RunStatus>;
}

// ── Run result (result page) ──────────────────────────────────────────────

export interface OpportunityDetail {
  ventureScore: number;
  confidenceScore: number;
  founderFitScore: number;
  /** null when no founder-fit rationale was stored. */
  founderFitRationale: string | null;
  rationaleBullets: string[];
  riskSummary: string[];
}

/**
 * Per-candidate scoring detail — surfaced for both the promoted winner
 * (redundant with `opportunity` in that case) and every non-promoted
 * candidate so the "no promotion" result view can show real evaluated
 * data instead of a generic "nothing cleared the bar" message.
 *
 * All numeric scores are on the 0-1 scale (the API normalises
 * founderFitScore's stored 0-100 to 0-1 at the boundary).
 *
 * `deprecationReason`:
 *   - "failed_gate"           — founder-fit below the min threshold
 *   - "lost_tiebreak"         — lost the tie-break to another candidate
 *   - "incomplete_composition"— missing required composition slots
 *   - null                    — either promoted or still status="candidate"
 */
export interface EvaluatedCandidate {
  id: string;
  status: string;
  opportunityQuality: number | null;
  confidenceScore: number | null;
  founderFitScore: number | null;
  ventureScore: number | null;
  founderFitRationale: string | null;
  deprecationReason: string | null;
  confidenceCoverageGate: boolean | null;
  incompleteComposition: boolean | null;
}

export interface RunResult {
  runId: string;
  overall: RunOverallStatus;
  /** Raw pipeline_run.status — distinguishes "insufficient_evidence" (candidates
   *  existed but none passed the gate) from a plain "completed" (winner promoted). */
  runStatus: string;
  vertical: string;
  /**
   * null when overall !== "completed", OR when the run completed but
   * Compression found no candidate above the bar (no promotion happened).
   */
  opportunity: OpportunityDetail | null;
  /** Every candidate row for the run — empty when zero candidates ever composed. */
  candidates: EvaluatedCandidate[];
  /** Refund/retry offer state for insufficient_evidence runs (migration 019). */
  postRunActions: PostRunActionsState;
}

/**
 * Refund / free-retry offer surfaced on insufficient_evidence runs.
 *
 *   offered: true only when the run is insufficient_evidence, the founder
 *   hasn't already resolved it, AND the run's parent chain walks up to a
 *   paid Stripe session. Dev/seeded runs (no Stripe root) never see this.
 *
 *   resolution: past choice — 'refunded' | 'retried' | 'accepted' | null.
 *   Once non-null the UI stops showing action buttons.
 *
 *   retryCapReached: true when the paid checkout has already spent its
 *   1 free retry — UI hides the "Retry" button and shows only "Refund".
 */
export interface PostRunActionsState {
  offered: boolean;
  resolution: string | null;
  resolvedAt: string | null;
  refundId: string | null;
  retryCapReached: boolean;
}

export async function getRunResult(runId: string, accessToken?: string): Promise<RunResult> {
  const res = await fetch(`${API_BASE}/runs/${runId}/result`, {
    cache: "no-store",
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (!res.ok) {
    throw new Error(`GET /runs/${runId}/result failed with status ${res.status}`);
  }
  return res.json() as Promise<RunResult>;
}

// ── Founder run list (dashboard) ──────────────────────────────────────────

// ── Founder intake (chat interview) ──────────────────────────────────────────

export type MustFillField = "expertise" | "distributionAssets" | "capitalAvailability";

export interface ContradictionFlag {
  detectedAt: string;
  field1: MustFillField;
  snippet1: string;
  field2: MustFillField;
  snippet2: string;
  message: string;
  resolved: boolean;
}

export interface IntakeTurnRequest {
  rawAnswer?: string;
  fieldTarget?: MustFillField;
}

export interface IntakeTurnResponse {
  intakeComplete: boolean;
  /** null when intakeComplete is true (coverage met or cap hit). */
  currentQuestion: {
    text: string;
    fieldTarget: MustFillField;
    isFollowUp: boolean;
  } | null;
  /** Non-null when the incoming answer contradicts an earlier answer. */
  contradictionFlag: ContradictionFlag | null;
  /** Total questions asked so far (including the one just returned). */
  questionCount: number;
}

/**
 * One intake turn. Call with an empty body on first load to receive the
 * opening question. On subsequent calls, include rawAnswer + fieldTarget
 * (the fieldTarget received in the previous response's currentQuestion).
 */
export async function postIntakeTurn(
  founderId: string,
  body: IntakeTurnRequest,
  accessToken?: string
): Promise<IntakeTurnResponse> {
  const res = await fetch(`${API_BASE}/founders/${founderId}/intake/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `POST /founders/${founderId}/intake/turn failed (${res.status}): ${text}`
    );
  }
  return res.json() as Promise<IntakeTurnResponse>;
}

// ── Run retry ─────────────────────────────────────────────────────────────

export async function retryRun(
  runId: string,
  accessToken?: string
): Promise<{ runId: string; retried: string[] }> {
  const res = await fetch(`${API_BASE}/runs/${runId}/retry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST /runs/${runId}/retry failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<{ runId: string; retried: string[] }>;
}

// ── Post-run actions: refund / free retry ─────────────────────────────────
//
// Only offered on insufficient_evidence terminal runs. See PostRunActionsState
// on RunResult for the gating logic — the API returns offered=false when
// either the run doesn't qualify or the founder has already resolved it.

export interface RefundRunResponse {
  runId: string;
  resolution: "refunded";
  refundId: string | null;
  stripeStatus?: string;
  alreadyRefunded?: boolean;
  alreadyRefundedAtStripe?: boolean;
  alreadyResolvedByRace?: boolean;
  message?: string;
}

export async function refundRun(
  runId: string,
  accessToken?: string
): Promise<RefundRunResponse> {
  const res = await fetch(`${API_BASE}/runs/${runId}/refund`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST /runs/${runId}/refund failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<RefundRunResponse>;
}

export interface FreeRetryRunResponse {
  /** The NEW pipeline_run's id — frontend should navigate to /runs/:newRunId. */
  runId: string;
  parentRunId: string;
  resolution: "retried";
}

export async function freeRetryRun(
  runId: string,
  accessToken?: string
): Promise<FreeRetryRunResponse> {
  const res = await fetch(`${API_BASE}/runs/${runId}/free-retry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`POST /runs/${runId}/free-retry failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<FreeRetryRunResponse>;
}

// ── Stripe checkout ───────────────────────────────────────────────────────

export async function createCheckoutSession(
  founderId: string,
  vertical: string,
  accessToken?: string
): Promise<{ url: string }> {
  const res = await fetch(`${API_BASE}/founders/${founderId}/checkout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ vertical }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Checkout session creation failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<{ url: string }>;
}

export interface CheckoutStatus {
  paid: boolean;
  runId: string | null;
}

export async function getCheckoutStatus(
  founderId: string,
  sessionId: string,
  accessToken?: string
): Promise<CheckoutStatus> {
  const res = await fetch(
    `${API_BASE}/founders/${founderId}/checkout-status?session_id=${encodeURIComponent(sessionId)}`,
    {
      cache: "no-store",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    }
  );
  if (!res.ok) {
    throw new Error(`Checkout status check failed (${res.status})`);
  }
  return res.json() as Promise<CheckoutStatus>;
}

// ── Free Market Signal Check ──────────────────────────────────────────────
//
// Discovery-only path — one per (founder, vertical). See migration 020 for
// the DB-level partial unique index. The API 409s with
// { error: "free_check_already_used", existingRunId } when the founder has
// already used their slot; the frontend surfaces that as the paid CTA path.

export interface SignalCheckStartResponse {
  runId: string;
}

export interface SignalCheckAlreadyUsedError extends Error {
  code: "free_check_already_used";
  existingRunId: string;
}

export async function startSignalCheck(
  founderId: string,
  vertical: string,
  accessToken: string
): Promise<SignalCheckStartResponse> {
  const res = await fetch(`${API_BASE}/founders/${founderId}/signal-check`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ vertical }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      existingRunId?: string;
    };
    const err = new Error(
      body.error ?? "free_check_already_used"
    ) as SignalCheckAlreadyUsedError;
    err.code = "free_check_already_used";
    err.existingRunId = body.existingRunId ?? "";
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Signal check failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<SignalCheckStartResponse>;
}

export interface SignalCheckResult {
  runId: string;
  vertical: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  failureReason: string | null;
  marketCount: number | null;
  growthSignal: number | null;
  summary: string | null;
}

export async function getSignalCheck(
  runId: string,
  accessToken: string
): Promise<SignalCheckResult> {
  const res = await fetch(`${API_BASE}/runs/${runId}/signal-check`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /runs/${runId}/signal-check failed (${res.status})`);
  }
  return res.json() as Promise<SignalCheckResult>;
}

// ── Founder run list (dashboard) ──────────────────────────────────────────

export async function getFounderRuns(founderId: string, accessToken?: string): Promise<FounderRun[]> {
  // TEMP DEBUG: probe Vercel→Railway edge behavior on runs list fetch
  const url = `${API_BASE}/founders/${founderId}/runs`;
  console.log("[TEMP DEBUG getFounderRuns] fetching", url, "hasToken=", Boolean(accessToken));
  let res: Response;
  try {
    res = await fetch(url, {
      // No caching — dashboard should always reflect live run state.
      cache: "no-store",
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  } catch (err) {
    console.log("[TEMP DEBUG getFounderRuns] FETCH THREW:", String(err));
    throw err;
  }
  const bodyText = await res.clone().text().catch(() => "<body read failed>");
  console.log(
    "[TEMP DEBUG getFounderRuns] status=", res.status,
    "server=", res.headers.get("server"),
    "x-railway-edge=", res.headers.get("x-railway-edge"),
    "x-hikari-trace=", res.headers.get("x-hikari-trace"),
    "body=", bodyText.slice(0, 300),
  );
  // END TEMP DEBUG
  if (!res.ok) {
    throw new Error(
      `GET /founders/${founderId}/runs failed with status ${res.status}`
    );
  }
  return res.json() as Promise<FounderRun[]>;
}
