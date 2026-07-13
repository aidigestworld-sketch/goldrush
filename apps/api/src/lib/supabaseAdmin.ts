import { createClient } from "@supabase/supabase-js";

// Service-role client — never expose to the browser.
// Used for JWT verification (auth.getUser) and privileged DB operations
// that bypass RLS. autoRefreshToken/persistSession disabled because this
// is a stateless server process, not a user session.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
