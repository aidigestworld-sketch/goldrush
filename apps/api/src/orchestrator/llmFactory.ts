// Factory for the per-agent NimLLMClient. Every handler that calls an
// LLM-bound agent goes through this so the model routing config is
// looked up once per agent name and the API key is validated in one
// place. Same pattern the existing runXLive.ts scripts follow, lifted
// into the Orchestrator so handlers don't each re-implement it.
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";

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
  return new NimLLMClient(apiKey, config.nimModelId);
}
