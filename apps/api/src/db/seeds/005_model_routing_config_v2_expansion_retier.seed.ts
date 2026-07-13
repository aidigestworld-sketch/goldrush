// Re-tiers Expansion from low_cost to mid_tier — version 2, Expansion
// only. Every other agent stays on whatever their latest version is
// (still version 1) — modelRoutingConfig.repository.ts's
// `latestForAgent` already reads per-agent, independently, so this
// doesn't require touching or re-inserting rows for anyone else.
//
// WHY: a live Phase 4 run of Expansion against an 8B-class low-cost
// NIM model produced only surface-level/mechanical Problem labels —
// never the causal/consequence framing this vertical was specifically
// chosen to require (VERTICAL_BASELINE.md §6). See AI_AGENTS.md §16's
// revision note for the full rationale. This is an empirical finding,
// not a guess — logged here as the concrete decision it produced.
import { prisma } from "../client";

const MID_TIER_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1"; // same placeholder used for Hypothesis/Validation/Confidence/FounderFit — verify exact catalog id on build.nvidia.com before relying on it

export async function seedModelRoutingConfigV2ExpansionRetier(): Promise<void> {
  await prisma.modelRoutingConfig.upsert({
    where: { version_agentName: { version: 2, agentName: "Expansion" } },
    create: { version: 2, agentName: "Expansion", nimModelId: MID_TIER_MODEL, tier: "mid_tier" },
    update: { nimModelId: MID_TIER_MODEL, tier: "mid_tier" },
  });
}

if (require.main === module) {
  seedModelRoutingConfigV2ExpansionRetier()
    .then(() => {
      console.log("Seeded model_routing_config v2 — Expansion re-tiered to mid_tier");
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
