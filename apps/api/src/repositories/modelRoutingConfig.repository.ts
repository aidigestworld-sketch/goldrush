// Read access for model_routing_config. Memory Agent is the only
// writer (AI_AGENTS.md §12) — read-only here, same reasoning as
// scoringConfig.repository.ts.
import { prisma } from "../db/client";

export const modelRoutingConfigRepository = {
  // Returns null for agents that deliberately have no row (Filtering,
  // Composition, Scoring, Memory, Orchestrator) — callers should treat
  // null as "this agent doesn't call a model," not an error.
  latestForAgent(agentName: string) {
    return prisma.modelRoutingConfig.findFirst({
      where: { agentName },
      orderBy: { version: "desc" },
    });
  },
};
