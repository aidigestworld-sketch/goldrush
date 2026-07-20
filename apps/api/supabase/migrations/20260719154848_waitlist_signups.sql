-- 017_waitlist_signups.sql
--
-- Captures email addresses from the public landing page waitlist form
-- (replaces the dropped "book a live session" CTA). The row is written
-- from an unauthenticated public route, so RLS is on and only INSERT
-- from anon/authenticated is allowed — select/update/delete stay
-- server-only via the service-role key (Supabase dashboard).
--
-- source is a soft label so a future secondary funnel (e.g. from a
-- product page or an email footer) can share this table without
-- ambiguity in the dashboard.

BEGIN;

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  source text DEFAULT 'landing'
);

ALTER TABLE waitlist_signups ENABLE ROW LEVEL SECURITY;

-- Public insert: the landing page is unauthenticated, so anon (and any
-- signed-in user) can add themselves. No SELECT/UPDATE/DELETE policy is
-- created — those default-deny for anon/authenticated once RLS is on.
CREATE POLICY waitlist_signups_anon_insert
  ON waitlist_signups
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

COMMIT;
