-- Adds intake_state (jsonb, nullable) to the founder table.
--
-- Rationale: the Founder Intake Engine needs per-field asked-tracking
-- that is distinct from the field's actual value. Without this column
-- the system cannot distinguish "field was asked and the founder said
-- they have nothing" from "field was never asked" — the same
-- null-vs-missing distinction that drove the P1.1/P1.2/P1.3/
-- capitalAvailability fixes elsewhere in the codebase.
--
-- The column stores a FounderIntakeState JSON blob:
--   {
--     "fields": {
--       "expertise":           { "asked": bool, "askedAt": ISO|null, "capTerminated": bool, "followUpAsked": bool, "depth": {"wordCount": n}|null },
--       "distributionAssets":  { ... },
--       "capitalAvailability": { ... }
--     },
--     "questionCount": n,
--     "completedAt": ISO|null,
--     "contradictionFlags": [
--       { "detectedAt": ISO, "field1": str, "snippet1": str, "field2": str, "snippet2": str, "message": str, "resolved": bool }
--     ]
--   }
--
-- Nullable: existing founder rows have no intake history; NULL means
-- "intake not started yet", which the engine handles as an all-unasked
-- initial state. A NOT NULL default would require back-filling a
-- well-formed JSON blob, which is noise for the single existing row.
--
-- JSONB (not JSON): enables GIN-index support if future queries need
-- to filter on intake completion state across many founders at once.
-- Currently no index is added — single-founder queries by id are
-- the only access pattern today.

BEGIN;

ALTER TABLE founder ADD COLUMN intake_state jsonb;

COMMIT;
