// Error serialization for persistence to dag_run_state.last_error and
// audit logs. Walks the .cause chain because Node/undici's "fetch failed"
// TypeError carries the underlying network/DNS/TLS error only in .cause
// (up to a few levels deep). Storing only err.message loses that detail
// — the top-level message is generic ("fetch failed", "Request failed",
// etc.) and useless for triage without .cause.
//
// The 07:32-38 UTC 2026-07-14 Validation incident hit exactly this:
// dag_run_state.last_error = "fetch failed" with no way to distinguish
// ECONNREFUSED / ENOTFOUND / ETIMEDOUT / TLS cert error / rate limit.

const MAX_CAUSE_DEPTH = 10;

// Return a single flattened string that fits in the DB column and is
// still readable by a human. Format:
//   TypeError: fetch failed
//     caused by: TypeError: fetch failed (code=UND_ERR_SOCKET)
//     caused by: Error: connect ECONNREFUSED 1.2.3.4:443 (code=ECONNREFUSED)
export function formatErrorForStorage(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let depth = 0;

  while (current !== null && current !== undefined && depth < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) {
      parts.push("  caused by: <cycle>");
      break;
    }
    seen.add(current);

    const line = describe(current);
    parts.push(depth === 0 ? line : `  caused by: ${line}`);

    // .cause was added in ES2022 and Node 16.9+. We treat it as `unknown`
    // because non-Error thrown values (strings, plain objects) may or may
    // not carry it. Only recurse when it's actually present.
    current = hasCause(current) ? current.cause : undefined;
    depth++;
  }

  if (depth === MAX_CAUSE_DEPTH && current !== null && current !== undefined) {
    parts.push("  caused by: <truncated: max cause depth reached>");
  }

  return parts.join("\n");
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    // Node/undici errors expose a numeric or string `code` on the error
    // itself (ECONNREFUSED, ETIMEDOUT, UND_ERR_SOCKET, etc.) — arguably
    // the single most useful field for triage, but not part of the base
    // Error type. Read it through a widening cast rather than reaching
    // into any-typed globals.
    const code = (value as { code?: unknown }).code;
    const name = value.name || "Error";
    const message = value.message || "";
    const codeSuffix = code !== undefined && code !== null ? ` (code=${String(code)})` : "";
    return `${name}: ${message}${codeSuffix}`;
  }
  if (typeof value === "string") return `string: ${value}`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value}: ${String(value)}`;
  }
  // Objects / other. Best-effort JSON serialization; fall back to
  // Object.prototype.toString if the value doesn't stringify (circular
  // JSON, BigInt fields, etc.).
  try {
    return `object: ${JSON.stringify(value)}`;
  } catch {
    return `object: ${Object.prototype.toString.call(value)}`;
  }
}

function hasCause(value: unknown): value is { cause: unknown } {
  return typeof value === "object" && value !== null && "cause" in value;
}

// Detects the "NIM API returned 504 Gateway Timeout" error class.
// NimLLMClient.complete throws `NIM API error (model=<id>): 504 <body>`
// on non-2xx responses, so any 504 from NIM's gateway lands as that
// exact prefix. Walks the .cause chain because the outer error may
// wrap the NIM error (BullMQ's job.failed wraps, undici sometimes
// re-throws) — the substring can be at any level.
//
// Used by the worker's fail-fast path: when NIM's shared gateway is
// timing out on a large request, retrying the identical request twice
// more in ~40s (BullMQ's exponential backoff) doesn't help and just
// hammers an already-struggling upstream. Detecting 504 here lets the
// worker skip the remaining automatic retries and go straight to
// failed_permanent — the user's manual "Retry analysis" button then
// gives NIM real minutes of breathing room instead of seconds. Other
// error classes (JSON parse failures, timeouts we control, network
// hiccups, etc.) intentionally do NOT match and keep the normal
// 3-attempt retry budget.
//
// Regex anchors "NIM API error" then requires the status token "504"
// to appear as a separate word after a colon — avoids false positives
// on anything that just mentions "504" incidentally in a body payload
// or on a "504 Gateway Timeout" mention inside our own error text.
const NIM_504_PATTERN = /NIM API error[^:]*:\s*504\b/;

export function isNimGatewayTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  let depth = 0;
  while (current !== null && current !== undefined && depth < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error && NIM_504_PATTERN.test(current.message)) {
      return true;
    }
    current = hasCause(current) ? current.cause : undefined;
    depth++;
  }
  return false;
}
