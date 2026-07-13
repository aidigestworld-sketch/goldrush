// Seeds model_routing_config version 1.
//
// Only agents that actually call an LLM get a row — Filtering,
// Composition, Scoring, Memory (lifecycle logic), and Orchestrator
// are deterministic/control-flow agents per AI_AGENTS.md §16 and
// never call a model, so they deliberately have NO row here. A
// repository lookup that finds nothing for one of those agent names
// should be read as "this agent doesn't call a model," not an error.
//
// Model IDs below are representative placeholders following NVIDIA's
// real Nano/Super/Ultra Nemotron naming convention (Nano = low-cost,
// cost-efficient; Super = higher-accuracy reasoning) — NOT verified
// against the live build.nvidia.com catalog. MVP_IMPLEMENTATION_PLAN.md
// Phase 0 already flags this: confirm the exact current catalog ID
// string on build.nvidia.com before any agent code calls it for real.
import { prisma } from "../client";

const LOW_COST_MODEL = "nvidia/nvidia-nemotron-nano-9b-v2"; // corrected — the original "nvidia/nemotron-nano-9b-v2" 404'd against the real NIM catalog (verified via GET /v1/models during CompetitiveAnalysis's first live run); this is the actual publisher/model_id path
const MID_TIER_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1"; // placeholder — verify on build.nvidia.com

const rows: { agentName: string; nimModelId: string; tier: string }[] = [
  { agentName: "Discovery", nimModelId: LOW_COST_MODEL, tier: "low_cost" },
  { agentName: "Expansion", nimModelId: LOW_COST_MODEL, tier: "low_cost" },
  { agentName: "CompetitiveAnalysis", nimModelId: LOW_COST_MODEL, tier: "low_cost" },
  { agentName: "Hypothesis", nimModelId: MID_TIER_MODEL, tier: "mid_tier" },
  { agentName: "Validation", nimModelId: MID_TIER_MODEL, tier: "mid_tier" },
  { agentName: "Confidence", nimModelId: MID_TIER_MODEL, tier: "mid_tier" },
  { agentName: "FounderFit", nimModelId: MID_TIER_MODEL, tier: "mid_tier" },
  { agentName: "Compression", nimModelId: MID_TIER_MODEL, tier: "mid_tier" }, // phrasing only, per AI_AGENTS.md §16
];

export async function seedModelRoutingConfigV1(): Promise<void> {
  for (const row of rows) {
    await prisma.modelRoutingConfig.upsert({
      where: { version_agentName: { version: 1, agentName: row.agentName } },
      create: { version: 1, ...row },
      update: { nimModelId: row.nimModelId, tier: row.tier },
    });
  }
}

if (require.main === module) {
  seedModelRoutingConfigV1()
    .then(() => {
      console.log(`Seeded model_routing_config v1: ${rows.length} rows`);
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
