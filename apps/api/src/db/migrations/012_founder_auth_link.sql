-- Links the founder row to a Supabase Auth user.
--
-- auth_user_id is nullable and has no default so that:
--   (a) The legacy seed founder (fd88ecae-5bf3-4289-a13e-6278a484eed9) used in
--       integration tests keeps auth_user_id = NULL and remains unaffected.
--   (b) The auth middleware can distinguish "no founder yet" (auth_user_id not
--       matched) from "founder exists" cleanly, without touching legacy rows.
--
-- UNIQUE ensures one founder row per Supabase Auth identity.
-- The callback route (POST /auth/callback) inserts the new row on first login.

BEGIN;

ALTER TABLE founder
  ADD COLUMN auth_user_id uuid UNIQUE;

COMMIT;
