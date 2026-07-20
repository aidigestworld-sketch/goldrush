// Kept as a pure Server Component (no async, no cookies) so "/" can stay
// statically renderable. Signed-in users who click "Log in" get bounced
// to /dashboard by middleware.ts (the `if (user && pathname === "/login")`
// branch), so the plain link works for both cases without forcing the
// landing page to opt into per-request SSR.
export default function LandingNav() {
  return (
    <nav className="gr-nav" data-testid="landing-nav">
      <div className="gr-brand">
        <span className="gr-brand-dot" aria-hidden="true" />
        GoldRush
      </div>
      <div className="gr-nav-actions">
        <a
          className="gr-nav-link"
          href="/login"
          data-testid="landing-nav-login"
        >
          Log in
        </a>
        <a className="gr-nav-cta" href="#waitlist" data-testid="landing-nav-cta">
          Join waitlist →
        </a>
      </div>
    </nav>
  );
}
