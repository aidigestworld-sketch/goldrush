import type { Metadata } from "next";
import LandingNav from "../components/landing/LandingNav";
import LandingHero from "../components/landing/LandingHero";
import LiveScanPanel from "../components/landing/LiveScanPanel";
import ExplainerTrio from "../components/landing/ExplainerTrio";
import LandingFooter from "../components/landing/LandingFooter";

export const metadata: Metadata = {
  title: "GoldRush — Watch your next revenue opportunity surface, live",
  description:
    "A 25-minute screen-share call where we run your own data through the engine and rank the moves worth making next, in real time.",
};

export default function LandingPage() {
  return (
    <div className="gr-root">
      <div className="gr-bg-grid" aria-hidden="true" />
      <div className="gr-bg-glow" aria-hidden="true" />

      <LandingNav />

      <main className="gr-main">
        <LandingHero />
        <LiveScanPanel />
        <ExplainerTrio />
      </main>

      <LandingFooter />
    </div>
  );
}
