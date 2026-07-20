// Two deliberately contrasting founder profiles, same opportunity —
// the opportunity is this project's own real gap-framed finding
// (VERTICAL_BASELINE.md §8's forced-cancellation gap), reframed as
// what building a solution to it would actually require. Founder
// profiles themselves are constructed test fixtures (not real data —
// this project doesn't have rich real founder data yet), but
// deliberately concrete and contrasting so the sandbox can test
// genuine differentiation, not just "does it run."
import type { FounderFitSandboxInput } from "../founderFitSandbox";

export const founderFitInputTechnical: FounderFitSandboxInput = {
  founder: {
    id: "founder-technical-solo",
    expertise: ["Shopify app development", "Node.js/TypeScript", "Shopify API integrations"],
    distributionAssets: [],
    capitalAvailability: "bootstrap, under $20K available",
    teamSize: 1,
    geography: "United States",
    founderEvidence: [],
    isLegacy: true,
  },
  opportunity: {
    label: "Forced Churn Recovery Layer",
    requirementsSummary:
      "Building this requires deep Shopify API / Shop Pay webhook integration to detect card-removal-triggered cancellations, and go-to-market requires reaching DTC subscription brand operators as the target buyer.",
  },
};

export const founderFitInputDistribution: FounderFitSandboxInput = {
  founder: {
    id: "founder-distribution-first",
    expertise: ["DTC subscription brand operations", "Retention marketing"],
    distributionAssets: ["Newsletter with 5,000 DTC subscription brand operator subscribers"],
    capitalAvailability: "$200K raised",
    teamSize: 2,
    geography: "United Kingdom",
    founderEvidence: [],
    isLegacy: true,
  },
  opportunity: {
    label: "Forced Churn Recovery Layer",
    requirementsSummary:
      "Building this requires deep Shopify API / Shop Pay webhook integration to detect card-removal-triggered cancellations, and go-to-market requires reaching DTC subscription brand operators as the target buyer.",
  },
};
