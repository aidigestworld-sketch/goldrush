// Unit tests for llmFactory's per-agent max_tokens override.
//
// The override exists to reduce gateway pressure on agents whose real
// output size is much smaller than DEFAULT_MAX_TOKENS (16384). The
// motivating incident: three consecutive NIM 504s on Validation
// against nvidia/llama-3.3-nemotron-super-49b-v1 with ~105K input +
// 16384 output on 2026-07-16. Halving Validation's requested output
// ceiling gives NIM's shared gateway a smaller compute reservation
// to hold.
//
// makeNimLlmForAgent hits the DB via modelRoutingConfigRepository —
// we mock the whole repository module so this test runs without a
// live Postgres connection.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NimLLMClient } from "../../sandbox/nimLLMClient";
import { AGENT_MAX_TOKENS_OVERRIDES, getMaxTokensForAgent } from "../llmFactory";

describe("getMaxTokensForAgent (pure lookup)", () => {
  it("returns 8192 for Validation — the fail-fast/gateway-pressure fix", () => {
    expect(getMaxTokensForAgent("Validation")).toBe(8192);
    expect(AGENT_MAX_TOKENS_OVERRIDES.Validation).toBe(8192);
  });

  it("returns DEFAULT_MAX_TOKENS (16384) for agents without an override", () => {
    // Discovery and Expansion legitimately need the headroom — pin their
    // fallback behavior explicitly so a future override that trims them
    // trips this test and forces a re-evaluation.
    expect(getMaxTokensForAgent("Discovery")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(getMaxTokensForAgent("Expansion")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(getMaxTokensForAgent("CompetitiveAnalysis")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(getMaxTokensForAgent("Hypothesis")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(getMaxTokensForAgent("Confidence")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(getMaxTokensForAgent("FounderFit")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(getMaxTokensForAgent("OpportunityRationale")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
  });

  it("returns DEFAULT_MAX_TOKENS for an unknown agent name", () => {
    expect(getMaxTokensForAgent("NotARealAgent")).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
  });
});

describe("makeNimLlmForAgent — constructs a NimLLMClient with the per-agent maxTokens", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "nvapi-test-key";
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("../../repositories/modelRoutingConfig.repository");
  });

  it("Validation → NimLLMClient with maxTokens=8192 (the override applied)", async () => {
    vi.doMock("../../repositories/modelRoutingConfig.repository", () => ({
      modelRoutingConfigRepository: {
        latestForAgent: async () => ({
          version: 2,
          agentName: "Validation",
          nimModelId: "nvidia/llama-3.3-nemotron-super-49b-v1",
          tier: "mid_tier",
          effectiveFrom: new Date(),
        }),
      },
    }));
    const { makeNimLlmForAgent } = await import("../llmFactory");
    const client = await makeNimLlmForAgent("Validation");
    // maxTokens is a public readonly field on NimLLMClient so config
    // tests can inspect it without reaching through the private wrap.
    expect(client.maxTokens).toBe(8192);
    expect(client.model).toBe("nvidia/llama-3.3-nemotron-super-49b-v1");
  });

  it("Discovery → NimLLMClient with maxTokens=16384 (unaffected by override)", async () => {
    vi.doMock("../../repositories/modelRoutingConfig.repository", () => ({
      modelRoutingConfigRepository: {
        latestForAgent: async () => ({
          version: 1,
          agentName: "Discovery",
          nimModelId: "nvidia/nvidia-nemotron-nano-9b-v2",
          tier: "low_cost",
          effectiveFrom: new Date(),
        }),
      },
    }));
    const { makeNimLlmForAgent } = await import("../llmFactory");
    const client = await makeNimLlmForAgent("Discovery");
    expect(client.maxTokens).toBe(NimLLMClient.DEFAULT_MAX_TOKENS);
    expect(client.maxTokens).toBe(16384);
  });

  it("throws when the repository returns no config for the agent", async () => {
    vi.doMock("../../repositories/modelRoutingConfig.repository", () => ({
      modelRoutingConfigRepository: {
        latestForAgent: async () => null,
      },
    }));
    const { makeNimLlmForAgent } = await import("../llmFactory");
    await expect(makeNimLlmForAgent("Nonexistent")).rejects.toThrow(
      /no model_routing_config found/
    );
  });
});
