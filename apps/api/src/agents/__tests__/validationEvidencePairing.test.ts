import { describe, it, expect } from "vitest";
import { pairInsertedEvidenceByUrl, type InsertedEvidenceRow } from "../live/validationEvidencePairing";
import type { NormalizedEvidence } from "../../pipeline/types";

function retrieved(url: string, fact: string): Pick<NormalizedEvidence, "sourceUrlOrIdentifier" | "extractedFact"> {
  return { sourceUrlOrIdentifier: url, extractedFact: fact };
}
function insertedRow(id: string, url: string, fetchedAtIso: string): InsertedEvidenceRow {
  return { id, sourceUrlOrIdentifier: url, fetchedAt: new Date(fetchedAtIso) };
}

describe("O.1: Validation search-evidence pairing", () => {
  it("happy path: both retrieved items paired to their real DB ids, no drops", () => {
    const r = [retrieved("https://a.example/1", "fact-A"), retrieved("https://b.example/2", "fact-B")];
    const inserted = [
      insertedRow("id-A", "https://a.example/1", "2026-07-12T10:00:00Z"),
      insertedRow("id-B", "https://b.example/2", "2026-07-12T10:00:01Z"),
    ];
    const { candidates, droppedUrls } = pairInsertedEvidenceByUrl(r, inserted);
    expect(candidates).toEqual([
      { id: "id-A", sourceUrlOrIdentifier: "https://a.example/1", text: "fact-A" },
      { id: "id-B", sourceUrlOrIdentifier: "https://b.example/2", text: "fact-B" },
    ]);
    expect(droppedUrls).toEqual([]);
  });

  it("shuffled: key-based pairing survives out-of-order findMany results", () => {
    const r = [retrieved("https://a.example/1", "fact-A"), retrieved("https://b.example/2", "fact-B")];
    const insertedShuffled = [
      insertedRow("id-B", "https://b.example/2", "2026-07-12T10:00:01Z"),
      insertedRow("id-A", "https://a.example/1", "2026-07-12T10:00:00Z"),
    ];
    const { candidates, droppedUrls } = pairInsertedEvidenceByUrl(r, insertedShuffled);
    const byUrl = new Map(candidates.map((c) => [c.sourceUrlOrIdentifier, c]));
    expect(byUrl.get("https://a.example/1")?.id).toBe("id-A");
    expect(byUrl.get("https://b.example/2")?.id).toBe("id-B");
    expect(byUrl.get("https://a.example/1")?.text).toBe("fact-A");
    expect(byUrl.get("https://b.example/2")?.text).toBe("fact-B");
    expect(droppedUrls).toEqual([]);
  });

  it("prior-run collision: newly-inserted row wins over older same-URL row", () => {
    const r = [retrieved("https://c.example/3", "new-extracted-fact")];
    const inserted = [
      insertedRow("id-C-new", "https://c.example/3", "2026-07-12T10:00:00Z"),
      insertedRow("id-C-old", "https://c.example/3", "2026-04-01T08:30:00Z"),
    ];
    const { candidates, droppedUrls } = pairInsertedEvidenceByUrl(r, inserted);
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe("id-C-new");
    expect(candidates[0].text).toBe("new-extracted-fact");
    expect(droppedUrls).toEqual([]);
  });

  it("genuine miss: unlocated URL reported as dropped, no fabricated placeholder id", () => {
    const r = [
      retrieved("https://d.example/4", "fact-D"),
      retrieved("https://e.example/5", "fact-E"),
    ];
    const inserted = [insertedRow("id-D", "https://d.example/4", "2026-07-12T10:00:00Z")];
    const { candidates, droppedUrls } = pairInsertedEvidenceByUrl(r, inserted);
    expect(candidates.length).toBe(1);
    expect(candidates[0].id).toBe("id-D");
    expect(candidates.every((c) => !c.id.startsWith("search-tmp-"))).toBe(true);
    expect(droppedUrls).toEqual(["https://e.example/5"]);
  });

  it("empty input: no candidates, no drops", () => {
    const { candidates, droppedUrls } = pairInsertedEvidenceByUrl([], []);
    expect(candidates).toEqual([]);
    expect(droppedUrls).toEqual([]);
  });
});
