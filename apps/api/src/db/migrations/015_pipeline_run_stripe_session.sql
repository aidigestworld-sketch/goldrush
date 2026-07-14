-- Adds stripe_session_id to pipeline_run for Stripe Checkout idempotency.
-- NULL = run created by direct orchestrate call (not via Stripe payment).
-- Non-null = run was created via Stripe Checkout; UNIQUE prevents a
--            duplicate run if Stripe delivers the webhook more than once
--            (Stripe guarantees at-least-once delivery).

BEGIN;

ALTER TABLE pipeline_run
  ADD COLUMN stripe_session_id TEXT UNIQUE;

COMMIT;
