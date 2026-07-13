-- Adds vertical (nullable text) to evidence.
--
-- Design decision (Task E): evidence stays a shared corpus but is
-- tagged by vertical so Discovery Agent can scope its read to only
-- the corpus relevant to the run's target vertical. Cross-run reuse
-- inside the SAME vertical stays intact — two orders on
-- shopify_subscriptions share ingested evidence — which is what makes
-- Tavily cost proportional to vertical count, not order count.
--
-- Nullable because pre-existing seed rows may not always be tagged
-- cleanly (see backfill below); a null vertical means "unclassified"
-- and is defensively filtered OUT by Discovery going forward (no
-- silent leaks into any run).
--
-- Backfill logic in this migration:
--   * Rows tagged in URL with `probe=b2b_customer_support_saas`
--     (from the earlier generalization probe) → b2b_customer_support_saas
--   * Everything else → shopify_subscriptions (the only other vertical
--     the current corpus was collected for)
-- If ambiguous rows ever enter the corpus later, a follow-up
-- classification step can populate vertical; for now this covers the
-- entire existing corpus deterministically.

BEGIN;

ALTER TABLE evidence
  ADD COLUMN vertical text;

UPDATE evidence
   SET vertical = 'b2b_customer_support_saas'
 WHERE source_url_or_identifier LIKE '%probe=b2b_customer_support_saas%';

UPDATE evidence
   SET vertical = 'shopify_subscriptions'
 WHERE vertical IS NULL;

-- Fast lookup for the Discovery read path — vertical + status is the
-- hot filter shape.
CREATE INDEX idx_evidence_vertical_status ON evidence (vertical, status);

COMMIT;
