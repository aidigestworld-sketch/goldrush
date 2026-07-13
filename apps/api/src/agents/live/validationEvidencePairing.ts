// Pure pairing helper split out of validationAgent.ts so the O.1
// regression test can import it without pulling in the prisma client
// module (which throws at import time when DATABASE_URL is unset).
//
// See validationAgent.ts:193-249 for the surrounding call site.
import type { ValidationCandidateEvidence } from "../../sandbox/validationSandbox";
import type { NormalizedEvidence } from "../../pipeline/types";

export interface InsertedEvidenceRow {
  id: string;
  sourceUrlOrIdentifier: string;
  fetchedAt: Date;
}

export interface PairInsertedEvidenceResult {
  candidates: ValidationCandidateEvidence[];
  // URLs that appeared in `retrieved` but couldn't be matched to any
  // row in `insertedRowsNewestFirst`. The caller is expected to log
  // these and drop them — NOT fabricate a placeholder evidence id.
  // Placeholders used to escape into node_source_refs and trip the FK.
  droppedUrls: string[];
}

// Pairs each retrieved NormalizedEvidence to its real DB evidence_id
// by sourceUrlOrIdentifier, not by array position. Callers must pass
// `insertedRowsNewestFirst` already ordered by fetchedAt descending
// (the agent achieves this with `orderBy: { fetchedAt: "desc" }` on
// the findMany that recovers the just-inserted rows). Newest-first
// + first-write-wins isolates this run's just-inserted row from any
// older rows for the same URL — a legitimate case whenever the same
// URL was scraped in a prior run of the same vertical, since
// Evidence.sourceUrlOrIdentifier has no unique constraint.
export function pairInsertedEvidenceByUrl(
  retrieved: Pick<NormalizedEvidence, "sourceUrlOrIdentifier" | "extractedFact">[],
  insertedRowsNewestFirst: InsertedEvidenceRow[]
): PairInsertedEvidenceResult {
  const urlToEvidenceId = new Map<string, string>();
  for (const row of insertedRowsNewestFirst) {
    if (!urlToEvidenceId.has(row.sourceUrlOrIdentifier)) {
      urlToEvidenceId.set(row.sourceUrlOrIdentifier, row.id);
    }
  }
  const candidates: ValidationCandidateEvidence[] = [];
  const droppedUrls: string[] = [];
  for (const e of retrieved) {
    const realId = urlToEvidenceId.get(e.sourceUrlOrIdentifier);
    if (!realId) {
      droppedUrls.push(e.sourceUrlOrIdentifier);
      continue;
    }
    candidates.push({
      id: realId,
      sourceUrlOrIdentifier: e.sourceUrlOrIdentifier,
      text: e.extractedFact,
    });
  }
  return { candidates, droppedUrls };
}
