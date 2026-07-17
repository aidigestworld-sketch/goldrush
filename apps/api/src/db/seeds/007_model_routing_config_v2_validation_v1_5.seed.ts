// Re-points Validation from nvidia/llama-3.3-nemotron-super-49b-v1 to the
// v1.5 point-release of the same model class — version 2, Validation only.
// Same pattern as 005 (Expansion re-tier): modelRoutingConfig.repository.ts's
// `latestForAgent` reads per-agent, so bumping only Validation to v2 doesn't
// disturb any other agent's routing.
//
// WHY: Validation on -v1 was hitting NIM's ~300s inference gateway wall on
// three consecutive attempts of run f17f7c6d (131 evidence rows, ~75K input
// tokens, 8192 max output tokens) — while Hypothesis and Expansion, on the
// SAME -v1 endpoint moments earlier, completed in 20s and 92s. The size of
// Validation's request is real, but the same-run same-model comparison
// argues the endpoint's current deployment is at capacity for larger jobs.
// -v1.5 is a fresh redeployment of the same model class published at
// docs.api.nvidia.com/nim/reference/nvidia-llama-3_3-nemotron-super-49b-v1_5
// — see NVIDIA developer forum precedent (thread 330894) where NVIDIA
// resolved an identical Llama-3.3 NIM 504 pattern via backend redeployment
// with no user-side workaround. This seed tests whether the -v1.5 endpoint
// has more headroom before we commit to task-level restructuring
// (batching / smaller-input) or a same-provider fallback (nano-9b-v2).
import { prisma } from "../client";

const VALIDATION_V1_5_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";

export async function seedModelRoutingConfigV2ValidationV1_5(): Promise<void> {
  await prisma.modelRoutingConfig.upsert({
    where: { version_agentName: { version: 2, agentName: "Validation" } },
    create: { version: 2, agentName: "Validation", nimModelId: VALIDATION_V1_5_MODEL, tier: "mid_tier" },
    update: { nimModelId: VALIDATION_V1_5_MODEL, tier: "mid_tier" },
  });
}

if (require.main === module) {
  seedModelRoutingConfigV2ValidationV1_5()
    .then(() => {
      console.log("Seeded model_routing_config v2 — Validation re-pointed to nvidia/llama-3.3-nemotron-super-49b-v1.5");
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
