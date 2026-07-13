import { defineConfig } from "vitest/config";

// Two categories of test files in this package:
//
// INCLUDED — converted to proper vitest describe/it/expect:
//   authRoutes.test.ts — HTTP + ownership checks across all 7 routes.
//     Needs Prisma but uses a fake JwtVerifier and enqueueStep no-op,
//     so no Supabase, Redis, or BullMQ required.
//
//   Self-contained (pure functions / mock LLM, no DB):
//     agents/__tests__: deterministicAgents, evidenceStrength,
//       p11p21ScoringProvenance, p32SourcePublishedAtRecency,
//       validationEvidencePairing
//     intake/__tests__: founderIntake
//     sandbox/__tests__: all 9 sandbox tests
//
// NOT INCLUDED — needs Redis or live BullMQ workers:
//   orchestrator/__tests__/endToEndIntegration.test.ts
//   pipeline/__tests__/ingest.test.ts
//   → excluded permanently; run via tsx + dotenv in dev
//
// NOT INCLUDED — needs Prisma but not yet converted:
//   checkpointIdempotency, founderRunsList, statusEndpoint,
//   intakeTurn, compressionAgent, confidenceMode2Agent,
//   filteringAgent, opportunityRationaleAgent,
//   runScopingIsolation, evidence.repository
//   → candidates for future migration
export default defineConfig({
  test: {
    include: [
      "src/orchestrator/__tests__/authRoutes.test.ts",
      "src/agents/__tests__/deterministicAgents.test.ts",
      "src/agents/__tests__/evidenceStrength.test.ts",
      "src/agents/__tests__/p11p21ScoringProvenance.test.ts",
      "src/agents/__tests__/p32SourcePublishedAtRecency.test.ts",
      "src/agents/__tests__/validationEvidencePairing.test.ts",
      "src/intake/__tests__/founderIntake.test.ts",
      "src/sandbox/__tests__/hypothesisSandbox.test.ts",
      "src/sandbox/__tests__/discoverySandbox.test.ts",
      "src/sandbox/__tests__/expansionSandbox.test.ts",
      "src/sandbox/__tests__/confidenceSandbox.test.ts",
      "src/sandbox/__tests__/competitiveAnalysisSandbox.test.ts",
      "src/sandbox/__tests__/founderFitSandbox.test.ts",
      "src/sandbox/__tests__/intakeExtractionSandbox.test.ts",
      "src/sandbox/__tests__/opportunityRationaleSandbox.test.ts",
      "src/sandbox/__tests__/validationSandbox.test.ts",
      "src/orchestrator/__tests__/checkpointIdempotency.test.ts",
      "src/orchestrator/__tests__/founderRunsList.test.ts",
      "src/orchestrator/__tests__/statusEndpoint.test.ts",
      "src/intake/__tests__/intakeTurn.test.ts",
      "src/agents/live/__tests__/compressionAgent.test.ts",
      "src/agents/live/__tests__/confidenceMode2Agent.test.ts",
      "src/agents/live/__tests__/filteringAgent.test.ts",
      "src/agents/live/__tests__/opportunityRationaleAgent.test.ts",
      "src/agents/live/__tests__/runScopingIsolation.test.ts",
      "src/repositories/__tests__/evidence.repository.test.ts",
    ],
    setupFiles: ["dotenv/config"],
    passWithNoTests: false,
  },
});
