import { describe, it, expect } from "vitest";
import {
  computeSupportingEvidenceStrength,
  EVIDENCE_STRENGTH_SATURATION,
} from "../evidenceStrength";

describe(`computeSupportingEvidenceStrength (saturation=${EVIDENCE_STRENGTH_SATURATION})`, () => {
  it("empty evidence returns 0 (not the 0.3 band floor)", () => {
    expect(computeSupportingEvidenceStrength([])).toBe(0);
  });

  it("2× industry_report (5+5=10) saturates to 1.0", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "industry_report" },
    ]);
    expect(Math.abs(actual - 1.0)).toBeLessThanOrEqual(0.001);
  });

  it("2× competitor_self_stated (4+4=8) hits 1.0 exactly", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "competitor_self_stated" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "competitor_self_stated" },
    ]);
    expect(Math.abs(actual - 1.0)).toBeLessThanOrEqual(0.001);
  });

  it("2× review_verified (3+3=6) → 0.75", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "review_verified" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "review_verified" },
    ]);
    expect(Math.abs(actual - 0.75)).toBeLessThanOrEqual(0.001);
  });

  it("2× forum_post (2+2=4) → 0.5", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "forum_post" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "forum_post" },
    ]);
    expect(Math.abs(actual - 0.5)).toBeLessThanOrEqual(0.001);
  });

  it("2× anonymous_comment (1+1=2) → 0.25 (weakest possible but non-zero)", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "anonymous_comment" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "anonymous_comment" },
    ]);
    expect(Math.abs(actual - 0.25)).toBeLessThanOrEqual(0.001);
  });

  it("same source twice counts once (5/8=0.625, not 10/8)", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
    ]);
    expect(Math.abs(actual - 5 / 8)).toBeLessThanOrEqual(0.001);
  });

  it("same source at two tiers keeps highest (5/8, not 2/8 or 7/8)", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "forum_post" },
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
    ]);
    expect(Math.abs(actual - 5 / 8)).toBeLessThanOrEqual(0.001);
  });

  it("1× industry_report + 1× forum_post → 7/8=0.875", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "forum_post" },
    ]);
    expect(Math.abs(actual - (5 + 2) / 8)).toBeLessThanOrEqual(0.001);
  });

  it("unknown tier weighs 0 (still 5/8 from the known industry_report)", () => {
    const actual = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "self_hosted_blog" },
    ]);
    expect(Math.abs(actual - 5 / 8)).toBeLessThanOrEqual(0.001);
  });

  it("10× industry_report caps at 1.0", () => {
    const actual = computeSupportingEvidenceStrength(
      Array.from({ length: 10 }, (_, i) => ({
        sourceUrlOrIdentifier: `https://src${i}.com`,
        sourceAuthorityTier: "industry_report",
      }))
    );
    expect(Math.abs(actual - 1.0)).toBeLessThanOrEqual(0.001);
  });

  it("same source-count, higher tier scores strictly higher (2× forum < 2× industry)", () => {
    const twoForumPosts = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "forum_post" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "forum_post" },
    ]);
    const twoIndustryReports = computeSupportingEvidenceStrength([
      { sourceUrlOrIdentifier: "https://a.com", sourceAuthorityTier: "industry_report" },
      { sourceUrlOrIdentifier: "https://b.com", sourceAuthorityTier: "industry_report" },
    ]);
    expect(twoForumPosts < twoIndustryReports).toBe(true);
  });
});
