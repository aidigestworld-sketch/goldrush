// Factory for the per-agent NimLLMClient. Every handler that calls an
// LLM-bound agent goes through this so the model routing config is
// looked up once per agent name and the API key is validated in one
// place. Same pattern the existing runXLive.ts scripts follow, lifted
// into the Orchestrator so handlers don't each re-implement it.
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";

export async function makeNimLlmForAgent(agentName: string): Promise<NimLLMClient> {
  const config = await modelRoutingConfigRepository.latestForAgent(agentName);
  if (!config) throw new Error(`no model_routing_config found for agent=${agentName}`);
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY is not set");
  return new NimLLMClient(apiKey, config.nimModelId);
}
