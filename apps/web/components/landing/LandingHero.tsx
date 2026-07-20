import WaitlistForm from "./WaitlistForm";

export default function LandingHero() {
  return (
    <>
      <div className="gr-eyebrow">Live session · 25 minutes · your data</div>

      <h1 className="gr-h1">
        Watch your next revenue
        <br />
        opportunity <span className="gr-accent">surface, live.</span>
      </h1>

      <p className="gr-sub">
        A 25-minute screen-share call where we run your own data through the
        engine — and you watch it rank the moves worth making next, in real
        time.
      </p>

      <div className="gr-cta-row" id="waitlist">
        <WaitlistForm />
        <span className="gr-cta-note">
          no dashboard to log into · nothing to install
        </span>
      </div>
    </>
  );
}
