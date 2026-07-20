// Factory for the per-agent NimLLMClient. Every handler that calls an
// LLM-bound agent goes through this so the model routing config is
// looked up once per agent name and the API key is validated in one
// place. Same pattern the existing runXLive.ts scripts follow, lifted
// into the Orchestrator so handlers don't each re-implement it.
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";

// Per-agent max_tokens overrides. Agents that don't appear here inherit
// NimLLMClient.DEFAULT_MAX_TOKENS (16384). Overrides only exist to
// reduce the requested output ceiling for agents whose real output is
// much smaller than 16K — a smaller max_tokens gives NIM's gateway a
// smaller compute reservation to hold, which meaningfully reduces the
// odds of a 504 gateway timeout on large-input requests.
//
// Validation → 8192: schema is classified_evidence[] + short arrays.
// Even at the ~300-candidate ceiling implied by the input budget this
// is only ~25K worst-case; realistic runs are 3–10K. Halving the ask
// is safe and cuts gateway pressure. Motivating incident: three
// consecutive 504s on nvidia/llama-3.3-nemotron-super-49b-v1 at
// ~105K input + 16384 output on 2026-07-16.
//
// Discovery/Expansion deliberately stay at 16384 — Discovery emits
// full markets[] with evidence_refs; Expansion emits problems[] with
// verbatim quote fields. Both legitimately need the headroom.
export const AGENT_MAX_TOKENS_OVERRIDES: Record<string, number> = {
  Validation: 8192,
};

export function getMaxTokensForAgent(agentName: string): number {
  return AGENT_MAX_TOKENS_OVERRIDES[agentName] ?? NimLLMClient.DEFAULT_MAX_TOKENS;
}

// Agents that reuse another agent's model_routing_config row when they
// don't have a dedicated one. Established by runOpportunityRationaleLive.ts
// (OpportunityRationale → FounderFit) and buildIntakeLLMClient in api.ts
// (IntakeExtraction → FounderFit). Lifted here so the orchestrator
// handler path follows the same rule as the manual live-runner path.
const AGENT_ROUTING_FALLBACKS: Record<string, string> = {
  OpportunityRationale: "FounderFit",
};

export async function makeNimLlmForAgent(agentName: string): Promise<NimLLMClient> {
  const primary = await modelRoutingConfigRepository.latestForAgent(agentName);
  const config =
    primary ??
    (AGENT_ROUTING_FALLBACKS[agentName]
      ? await modelRoutingConfigRepository.latestForAgent(AGENT_ROUTING_FALLBACKS[agentName])
      : null);
  if (!config) {
    const fallback = AGENT_ROUTING_FALLBACKS[agentName];
    throw new Error(
      fallback
        ? `no model_routing_config found for agent=${agentName} (also tried fallback=${fallback})`
        : `no model_routing_config found for agent=${agentName}`
    );
  }
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  return new NimLLMClient(
    apiKey,
    config.nimModelId,
    undefined,
    getMaxTokensForAgent(agentName)
  );
}
