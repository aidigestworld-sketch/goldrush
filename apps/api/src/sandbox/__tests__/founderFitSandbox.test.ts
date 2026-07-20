import { describe, it, expect } from "vitest";
import { runFounderFitSandbox } from "../founderFitSandbox";
import type { FounderFitSandboxInput } from "../founderFitSandbox";
import { founderFitInputTechnical, founderFitInputDistribution } from "../__fixtures__/founder-fit-input";
import type { LLMClient } from "../llmClient";

// ── Module-level mock LLMs ────────────────────────────────────────────────────

class GoodTechnicalMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 55,
      matched_strengths: [
        {
          source_field: "expertise",
          matched_value: "Shopify API integrations",
          why_it_matters: "Directly covers the Shop Pay webhook integration this opportunity requires to build at all.",
        },
      ],
      gaps: ["No existing distribution to DTC subscription brand operators — the target buyer for this opportunity."],
      rationale:
        "Strong technical fit for the build itself, but no distribution asset to reach the target buyer — would need to build an audience or rely on paid acquisition/partnerships from zero.",
    });
  }
}

class GoodDistributionMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 50,
      matched_strengths: [
        {
          source_field: "distribution_assets",
          matched_value: "Newsletter with 5,000 DTC subscription brand operator subscribers",
          why_it_matters: "Direct, existing reach into exactly the target buyer this opportunity needs — no cold-start distribution problem.",
        },
      ],
      gaps: ["No stated technical/Shopify API expertise — would need to hire or partner with an engineer to build the actual integration."],
      rationale:
        "Strong go-to-market fit via existing distribution, but no technical capability of their own to build the Shop Pay integration this specifically requires.",
    });
  }
}

class HallucinatedMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 80,
      matched_strengths: [
        {
          source_field: "distribution_assets",
          matched_value: "Existing audience of Shopify merchants",
          why_it_matters: "Would make go-to-market easy.",
        },
      ],
      gaps: [],
      rationale: "Great fit across the board.",
    });
  }
}

class NullCapHallucinationMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 60,
      matched_strengths: [
        {
          source_field: "capital_availability",
          matched_value: "unspecified",
          why_it_matters: "Capital availability is unspecified so constraints are unclear.",
        },
      ],
      gaps: [],
      rationale: "Technically capable founder with unspecified but potentially adequate capital.",
    });
  }
}

class NullCapGoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 55,
      matched_strengths: [
        {
          source_field: "expertise",
          matched_value: "Shopify API integrations",
          why_it_matters: "Directly covers the Shop Pay webhook integration this opportunity requires.",
        },
      ],
      gaps: ["Capital availability unknown — cannot assess competitive funding gap against incumbents."],
      rationale: "Strong technical fit. Capital availability not stated; must treat funding capacity as a gap.",
    });
  }
}

class RealCapGoodMockLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 55,
      matched_strengths: [
        {
          source_field: "capital_availability",
          matched_value: "$200K raised",
          why_it_matters: "Sufficient runway to reach first paying customer without external funding pressure.",
        },
      ],
      gaps: ["No technical Shopify API expertise — build requires a co-founder or contractor hire."],
      rationale: "Adequate capital to de-risk go-to-market phase. Technical capability is the critical gap.",
    });
  }
}

const EV_EXPERTISE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const EV_DIST      = "b2c3d4e5-f6a7-8901-bcde-f01234567891";
const EV_CAP       = "c3d4e5f6-a7b8-9012-cdef-012345678912";
const EV_TEAM      = "d4e5f6a7-b8c9-0123-def0-123456789123";
const EV_GEO       = "e5f6a7b8-c9d0-1234-ef01-234567891234";

const nonLegacyInput: FounderFitSandboxInput = {
  founder: {
    id: "founder-evidence-test",
    expertise: ["Shopify app development"],
    distributionAssets: ["Newsletter with 5,000 DTC brand operator subscribers"],
    capitalAvailability: "$50K available",
    teamSize: 3,
    geography: "United States",
    founderEvidence: [
      {
        id: EV_EXPERTISE,
        targetField: "expertise",
        extractedValue: "Shopify app development",
        rawAnswer: "I've been building Shopify apps for five years, mostly checkout and webhook integrations.",
      },
      {
        id: EV_DIST,
        targetField: "distribution_assets",
        extractedValue: "Newsletter with 5,000 DTC brand operator subscribers",
        rawAnswer: "I run a newsletter that goes out to about 5,000 DTC brand operators each week.",
      },
      {
        id: EV_CAP,
        targetField: "capital_availability",
        extractedValue: "$50K available",
        rawAnswer: "I have around fifty thousand dollars I can put in before needing outside money.",
      },
      {
        id: EV_TEAM,
        targetField: "team_size",
        extractedValue: "3",
        rawAnswer: "It's me and two co-founders — three of us working on it full time.",
      },
      {
        id: EV_GEO,
        targetField: "geography",
        extractedValue: "United States",
        rawAnswer: "We're all based in the United States, mostly the Bay Area.",
      },
    ],
    isLegacy: false,
  },
  opportunity: founderFitInputTechnical.opportunity,
};

const nullCapInput: FounderFitSandboxInput = {
  founder: {
    id: "founder-null-cap",
    expertise: ["Shopify API integrations"],
    distributionAssets: [],
    capitalAvailability: null,
    teamSize: null,
    geography: null,
    founderEvidence: [],
    isLegacy: true,
  },
  opportunity: founderFitInputTechnical.opportunity,
};

class GoodGroundedLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 65,
      matched_strengths: [
        {
          source_field: "expertise",
          founder_evidence_id: EV_EXPERTISE,
          matched_value: "Shopify app development",
          why_it_matters: "Directly covers the webhook integration this opportunity requires.",
        },
      ],
      gaps: ["No existing channel to DTC subscription brands as paying customers — distribution is strong but newsletter readers are operators, not buyers."],
      rationale: "Technical capability is a strong fit. Distribution asset reaches the right audience. Capital is tight but enough to get to first revenue.",
    });
  }
}

class MissingEvidenceIdLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 65,
      matched_strengths: [
        {
          source_field: "expertise",
          matched_value: "Shopify app development",
          why_it_matters: "Covers the build requirement.",
        },
      ],
      gaps: [],
      rationale: "Good technical fit overall for this opportunity.",
    });
  }
}

class NonexistentEvidenceIdLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 65,
      matched_strengths: [
        {
          source_field: "expertise",
          founder_evidence_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          matched_value: "Shopify app development",
          why_it_matters: "Covers the build requirement.",
        },
      ],
      gaps: [],
      rationale: "Good technical fit overall for this opportunity.",
    });
  }
}

class WrongFieldEvidenceIdLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 65,
      matched_strengths: [
        {
          source_field: "expertise",
          founder_evidence_id: EV_DIST,
          matched_value: "Newsletter with 5,000 DTC brand operator subscribers",
          why_it_matters: "Has domain expertise via the newsletter.",
        },
      ],
      gaps: [],
      rationale: "Good overall fit for this particular opportunity.",
    });
  }
}

class ContentMismatchEvidenceIdLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 65,
      matched_strengths: [
        {
          source_field: "expertise",
          founder_evidence_id: EV_EXPERTISE,
          matched_value: "machine learning and data pipeline engineering",
          why_it_matters: "Would allow building the recommendation engine.",
        },
      ],
      gaps: [],
      rationale: "Strong AI background.",
    });
  }
}

class LegacyCapMatchLLM implements LLMClient {
  async complete(): Promise<string> {
    return JSON.stringify({
      founder_fit_score: 55,
      matched_strengths: [
        {
          source_field: "capital_availability",
          matched_value: "$200K raised",
          why_it_matters: "Sufficient to reach first customer without external funding pressure.",
        },
      ],
      gaps: ["No Shopify API technical expertise."],
      rationale: "Capital is fine; technical capability is the gap.",
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("founderFitSandbox — technical and distribution founders", () => {
  it("technical founder: parses, no validation errors, matched_strength is genuinely grounded", async () => {
    const technical = await runFounderFitSandbox(new GoodTechnicalMockLLM(), founderFitInputTechnical);
    expect(technical.parsed).not.toBeNull();
    expect(technical.validationErrors.length).toBe(0);
    expect(technical.boundedRuleViolations.length).toBe(0);
  });

  it("distribution founder: parses, matched_strength genuinely grounded in profile", async () => {
    const distribution = await runFounderFitSandbox(new GoodDistributionMockLLM(), founderFitInputDistribution);
    expect(distribution.parsed).not.toBeNull();
    expect(distribution.boundedRuleViolations.length).toBe(0);
  });

  it("the two founders' matched_strengths and gaps differ — real differentiation, not a template", async () => {
    const technical = await runFounderFitSandbox(new GoodTechnicalMockLLM(), founderFitInputTechnical);
    const distribution = await runFounderFitSandbox(new GoodDistributionMockLLM(), founderFitInputDistribution);
    expect(technical.parsed?.matched_strengths[0]?.source_field).not.toBe(distribution.parsed?.matched_strengths[0]?.source_field);
    expect(technical.parsed?.gaps[0]).not.toBe(distribution.parsed?.gaps[0]);
  });

  it("hallucinated distribution asset: parses but invented capability caught", async () => {
    const hallucinated = await runFounderFitSandbox(new HallucinatedMockLLM(), founderFitInputTechnical);
    expect(hallucinated.parsed).not.toBeNull();
    expect(hallucinated.boundedRuleViolations.some((v) => v.includes("invented capability"))).toBe(true);
  });
});

describe("founderFitSandbox — null capitalAvailability", () => {
  it("claiming matched_strength on absent capitalAvailability triggers bounded-rule violation", async () => {
    const nullCapHallucinated = await runFounderFitSandbox(new NullCapHallucinationMockLLM(), nullCapInput);
    expect(nullCapHallucinated.parsed).not.toBeNull();
    expect(nullCapHallucinated.boundedRuleViolations.length).toBeGreaterThan(0);
    expect(nullCapHallucinated.boundedRuleViolations.some((v) => v.includes("capital_availability"))).toBe(true);
  });

  it("well-behaved response grounded on real expertise field passes even when capitalAvailability is null", async () => {
    const nullCapGood = await runFounderFitSandbox(new NullCapGoodMockLLM(), nullCapInput);
    expect(nullCapGood.parsed).not.toBeNull();
    expect(nullCapGood.boundedRuleViolations.length).toBe(0);
  });
});

describe("founderFitSandbox — regression: non-null capitalAvailability (fd88ecae)", () => {
  it("$200K raised is a real profile value — matched_strength passes bounded-rule, retained in output", async () => {
    const realCapResult = await runFounderFitSandbox(new RealCapGoodMockLLM(), founderFitInputDistribution);
    expect(realCapResult.parsed).not.toBeNull();
    expect(realCapResult.boundedRuleViolations.length).toBe(0);
    expect(realCapResult.parsed?.matched_strengths[0]?.source_field).toBe("capital_availability");
  });
});

describe("founderFitSandbox — evidence-id grounding (non-legacy profiles)", () => {
  it("well-cited response: citing real evidence id for correct field passes", async () => {
    const groundedGood = await runFounderFitSandbox(new GoodGroundedLLM(), nonLegacyInput);
    expect(groundedGood.parsed).not.toBeNull();
    expect(groundedGood.validationErrors.length).toBe(0);
    expect(groundedGood.boundedRuleViolations.length).toBe(0);
  });

  it("missing founder_evidence_id on non-legacy profile fires a violation", async () => {
    const missingId = await runFounderFitSandbox(new MissingEvidenceIdLLM(), nonLegacyInput);
    expect(missingId.parsed).not.toBeNull();
    expect(missingId.boundedRuleViolations.some((v) => v.includes("missing founder_evidence_id"))).toBe(true);
  });

  it("nonexistent evidence id fires a violation", async () => {
    const nonexistentId = await runFounderFitSandbox(new NonexistentEvidenceIdLLM(), nonLegacyInput);
    expect(nonexistentId.boundedRuleViolations.some((v) => v.includes("not found in this founder's evidence trail"))).toBe(true);
  });

  it("evidence from wrong field fires a field-mismatch violation", async () => {
    const wrongField = await runFounderFitSandbox(new WrongFieldEvidenceIdLLM(), nonLegacyInput);
    expect(wrongField.boundedRuleViolations.some((v) => v.includes("field mismatch"))).toBe(true);
  });

  it("matched_value with no content overlap to cited evidence fires a violation", async () => {
    const contentMismatch = await runFounderFitSandbox(new ContentMismatchEvidenceIdLLM(), nonLegacyInput);
    expect(contentMismatch.boundedRuleViolations.some((v) => v.includes("does not appear in the cited evidence"))).toBe(true);
  });
});

describe("founderFitSandbox — legacy regression", () => {
  it("isLegacy=true bypasses evidence-id requirement and uses string-matching fallback", async () => {
    const legacyReg = await runFounderFitSandbox(new LegacyCapMatchLLM(), founderFitInputDistribution);
    expect(legacyReg.parsed).not.toBeNull();
    expect(legacyReg.boundedRuleViolations.length).toBe(0);
  });

  it("legacy founder with 5 required fields (all provided) — legacy path unchanged, no violations", async () => {
    // The single legacy fixture founder (isLegacy: true, zero evidence) still
    // scores fine against a well-grounded matched_strength claim on any of
    // the 5 fields — the coverage widening from 3→5 does not change the
    // fallback semantics for pre-Intake-Engine founders.
    class LegacyGeoMatchLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 55,
          matched_strengths: [
            {
              source_field: "geography",
              matched_value: "United Kingdom",
              why_it_matters: "Founder is UK-based and the target buyer set is UK-heavy DTC subscription operators.",
            },
          ],
          gaps: ["No stated Shopify API technical expertise."],
          rationale: "Geographic overlap with the target buyer helps go-to-market. Technical gap dominates the score.",
        });
      }
    }
    const legacyGeo = await runFounderFitSandbox(new LegacyGeoMatchLLM(), founderFitInputDistribution);
    expect(legacyGeo.parsed).not.toBeNull();
    expect(legacyGeo.boundedRuleViolations.length).toBe(0);
  });
});

describe("founderFitSandbox — teamSize grounding (legacy path)", () => {
  it("claiming a teamSize matched_strength that matches the profile passes", async () => {
    class LegacyTeamMatchLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 45,
          matched_strengths: [
            {
              source_field: "team_size",
              matched_value: "2",
              why_it_matters: "Two full-time founders can plausibly divide the build/GTM work — enough surface area to execute.",
            },
          ],
          gaps: ["No dedicated Shopify API technical expertise stated."],
          rationale: "Team size is workable; expertise breadth is the real gap.",
        });
      }
    }
    const result = await runFounderFitSandbox(new LegacyTeamMatchLLM(), founderFitInputDistribution);
    expect(result.boundedRuleViolations.length).toBe(0);
  });

  it("claiming teamSize matched_strength when profile teamSize=null fires a violation", async () => {
    class LegacyTeamHallucinationLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 60,
          matched_strengths: [
            {
              source_field: "team_size",
              matched_value: "5",
              why_it_matters: "Large team can cover both build and GTM.",
            },
          ],
          gaps: [],
          rationale: "Team is strong across the board.",
        });
      }
    }
    const result = await runFounderFitSandbox(new LegacyTeamHallucinationLLM(), nullCapInput);
    expect(result.boundedRuleViolations.length).toBeGreaterThan(0);
    expect(result.boundedRuleViolations.some((v) => v.includes("team_size"))).toBe(true);
  });
});

describe("founderFitSandbox — geography grounding (legacy path)", () => {
  it("claiming geography matched_strength when profile geography=null fires a violation", async () => {
    class LegacyGeoHallucinationLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 60,
          matched_strengths: [
            {
              source_field: "geography",
              matched_value: "United States",
              why_it_matters: "US-based founder is well positioned for the US-heavy target market.",
            },
          ],
          gaps: [],
          rationale: "Good regional fit, US market alignment is a real advantage here.",
        });
      }
    }
    const result = await runFounderFitSandbox(new LegacyGeoHallucinationLLM(), nullCapInput);
    expect(result.boundedRuleViolations.length).toBeGreaterThan(0);
    expect(result.boundedRuleViolations.some((v) => v.includes("geography"))).toBe(true);
  });
});

describe("founderFitSandbox — teamSize/geography evidence-id grounding (non-legacy)", () => {
  it("well-cited teamSize evidence passes grounding", async () => {
    class GoodTeamGroundedLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 60,
          matched_strengths: [
            {
              source_field: "team_size",
              founder_evidence_id: EV_TEAM,
              matched_value: "3",
              why_it_matters: "Three-person team can plausibly execute both build and go-to-market in parallel.",
            },
          ],
          gaps: ["Capital is thin relative to the CAC of DTC subscription operators."],
          rationale: "Team size and expertise are adequate; capital is the operational constraint.",
        });
      }
    }
    const result = await runFounderFitSandbox(new GoodTeamGroundedLLM(), nonLegacyInput);
    expect(result.boundedRuleViolations.length).toBe(0);
  });

  it("well-cited geography evidence passes grounding", async () => {
    class GoodGeoGroundedLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 55,
          matched_strengths: [
            {
              source_field: "geography",
              founder_evidence_id: EV_GEO,
              matched_value: "United States",
              why_it_matters: "US-based team can serve the US-heavy target buyer set without time-zone or regulatory friction.",
            },
          ],
          gaps: [],
          rationale: "Geographic fit removes go-to-market friction that a non-US team would face.",
        });
      }
    }
    const result = await runFounderFitSandbox(new GoodGeoGroundedLLM(), nonLegacyInput);
    expect(result.boundedRuleViolations.length).toBe(0);
  });

  it("teamSize claim citing a wrong-field evidence id fires a field-mismatch violation", async () => {
    class TeamWrongFieldLLM implements LLMClient {
      async complete(): Promise<string> {
        return JSON.stringify({
          founder_fit_score: 55,
          matched_strengths: [
            {
              source_field: "team_size",
              founder_evidence_id: EV_EXPERTISE,
              matched_value: "3",
              why_it_matters: "Three-person team.",
            },
          ],
          gaps: [],
          rationale: "Good team fit — three founders can cover build plus GTM.",
        });
      }
    }
    const result = await runFounderFitSandbox(new TeamWrongFieldLLM(), nonLegacyInput);
    expect(result.boundedRuleViolations.some((v) => v.includes("field mismatch"))).toBe(true);
  });
});
