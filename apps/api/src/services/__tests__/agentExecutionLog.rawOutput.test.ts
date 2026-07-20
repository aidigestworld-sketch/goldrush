// Regression for the raw-output persistence added to agent_execution_log.
//
// Motivation: the ba923046 incident (2026-07-15) had Discovery return
// with `graphMutationCount=0` and no way to inspect what the LLM
// actually produced — the log schema stored only `output_hash`, which
// is useless for diagnosing empty/malformed model outputs. This test
// confirms:
//   1. rawOutput passed via ctx.setRawOutput lands on the row.
//   2. rawOutput on failure (agent throws) also persists — the
//      most triage-critical case.
//   3. Truncation at RAW_OUTPUT_MAX_BYTES prevents jumbo completions
//      from bloating the table.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../db/client";
import { agentExecutionLogService } from "../agentExecutionLog.service";
import { RAW_OUTPUT_MAX_BYTES } from "../../repositories/agentExecutionLog.repository";

const AUTH_USER_ID = "f867b348-6666-4000-a000-000000000060";
const RUN_ID = "f867b348-6666-4000-a000-000000000061";

describe("AgentExecutionLog raw_output persistence", () => {
  let founderId: string;

  beforeAll(async () => {
    await prisma.agentExecutionLog.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    const founder = await prisma.founder.create({
      data: { authUserId: AUTH_USER_ID, expertise: [], industries: [], constraints: [] },
    });
    founderId = founder.id;
    await prisma.pipelineRun.create({
      data: { runId: RUN_ID, founderId, vertical: "shopify_subscriptions" },
    });
  });

  afterAll(async () => {
    await prisma.agentExecutionLog.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    await prisma.$disconnect();
  });

  it("ctx.setRawOutput on success → row.rawOutput is persisted verbatim", async () => {
    const rawLlmResponse = '{"markets":[{"label":"Test market"}]}';
    await agentExecutionLogService.run(
      { runId: RUN_ID, agentName: "TestAgent-Success" },
      async (ctx) => {
        ctx.setRawOutput(rawLlmResponse);
        return { ok: true };
      }
    );
    const row = await prisma.agentExecutionLog.findFirst({
      where: { runId: RUN_ID, agentName: "TestAgent-Success" },
    });
    expect(row?.rawOutput).toBe(rawLlmResponse);
    expect(row?.status).toBe("success");
  });

  it("ctx.setRawOutput before throwing → row.rawOutput persists on FAILED status too", async () => {
    // This is the triage-critical case: Discovery hits empty-markets,
    // the handler throws to trigger retry, and we still want the raw
    // LLM response captured so we can see what the model actually said.
    const rawLlmResponse = '{"markets":[]}';
    await expect(
      agentExecutionLogService.run(
        { runId: RUN_ID, agentName: "TestAgent-Failure" },
        async (ctx) => {
          ctx.setRawOutput(rawLlmResponse);
          throw new Error("simulated: empty markets — retrying");
        }
      )
    ).rejects.toThrow("simulated: empty markets");

    const row = await prisma.agentExecutionLog.findFirst({
      where: { runId: RUN_ID, agentName: "TestAgent-Failure" },
    });
    expect(row?.rawOutput).toBe(rawLlmResponse);
    expect(row?.status).toBe("failed");
  });

  it("agent that never calls setRawOutput (deterministic) → row.rawOutput is null", async () => {
    await agentExecutionLogService.run(
      { runId: RUN_ID, agentName: "TestAgent-Deterministic" },
      async () => {
        // No ctx.setRawOutput — deterministic agent (Filtering, Composition, etc).
        return { ok: true };
      }
    );
    const row = await prisma.agentExecutionLog.findFirst({
      where: { runId: RUN_ID, agentName: "TestAgent-Deterministic" },
    });
    expect(row?.rawOutput).toBeNull();
  });

  it("jumbo output above RAW_OUTPUT_MAX_BYTES is truncated with an explicit marker", async () => {
    const jumbo = "x".repeat(RAW_OUTPUT_MAX_BYTES + 5000);
    await agentExecutionLogService.run(
      { runId: RUN_ID, agentName: "TestAgent-Jumbo" },
      async (ctx) => {
        ctx.setRawOutput(jumbo);
        return { ok: true };
      }
    );
    const row = await prisma.agentExecutionLog.findFirst({
      where: { runId: RUN_ID, agentName: "TestAgent-Jumbo" },
    });
    expect(row?.rawOutput).not.toBeNull();
    expect(row!.rawOutput!.length).toBeGreaterThan(RAW_OUTPUT_MAX_BYTES);
    expect(row!.rawOutput!.length).toBeLessThan(RAW_OUTPUT_MAX_BYTES + 500);
    expect(row!.rawOutput!).toContain("[...truncated");
    expect(row!.rawOutput!).toContain(`original was ${jumbo.length} chars`);
  });
});
