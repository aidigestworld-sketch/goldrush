// Pure recency-tiebreak helper used by compressionAgent.ts.
// Split into its own module so P3.2's regression test can import it
// without pulling in prisma (which throws at import when DATABASE_URL
// is unset), same pattern as validationEvidencePairing.ts.
//
// Contract:
//   - Prefers sourcePublishedAt when non-null (source-side publish
//     date, the whole point of migration 007).
//   - Falls back to fetchedAt when sourcePublishedAt is null. The
//     fallback is EXPLICIT: `usedTimestamp` on each row records which
//     of the two was actually consumed. Aggregate counts are also
//     surfaced so the caller can log/audit without re-scanning the
//     per-row list.
//   - Empty input returns lastEvidenceSeenAt = null. The live caller
//     is responsible for its own second-tier fallback (candidate
//     createdAt) — the pure function doesn't guess a policy.
export interface EvidenceRecencyInput {
  id: string;
  fetchedAt: Date;
  sourcePublishedAt: Date | null;
}

export interface EvidenceRecencyProvenance {
  evidenceId: string;
  usedTimestamp: "source_published_at" | "fetched_at_fallback";
  recency: Date;
}

export interface MaxRecencyResult {
  lastEvidenceSeenAt: Date | null;
  // Which timestamp source drove the MAX specifically. Independent of
  // per-row provenance because the winning row (with the latest
  // recency) may have used either source. If input is empty this is
  // "empty".
  maxUsedTimestamp: "source_published_at" | "fetched_at_fallback" | "empty";
  // Aggregate counts across the input rows — useful for run-level
  // reporting ("N of M rows had a real published date").
  sourcePublishedCount: number;
  fetchedAtFallbackCount: number;
  perRow: EvidenceRecencyProvenance[];
}

export function computeMaxEvidenceRecency(rows: EvidenceRecencyInput[]): MaxRecencyResult {
  const perRow: EvidenceRecencyProvenance[] = rows.map((r) => {
    const usedSource = r.sourcePublishedAt !== null;
    return {
      evidenceId: r.id,
      usedTimestamp: usedSource ? "source_published_at" : "fetched_at_fallback",
      recency: usedSource ? (r.sourcePublishedAt as Date) : r.fetchedAt,
    };
  });
  const sourcePublishedCount = perRow.filter((p) => p.usedTimestamp === "source_published_at").length;
  const fetchedAtFallbackCount = perRow.length - sourcePublishedCount;

  if (perRow.length === 0) {
    return {
      lastEvidenceSeenAt: null,
      maxUsedTimestamp: "empty",
      sourcePublishedCount: 0,
      fetchedAtFallbackCount: 0,
      perRow,
    };
  }

  let winner = perRow[0];
  for (const p of perRow) {
    if (p.recency > winner.recency) winner = p;
  }
  return {
    lastEvidenceSeenAt: winner.recency,
    maxUsedTimestamp: winner.usedTimestamp,
    sourcePublishedCount,
    fetchedAtFallbackCount,
    perRow,
  };
}
