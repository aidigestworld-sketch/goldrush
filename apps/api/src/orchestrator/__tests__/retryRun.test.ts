// Behavior tests for POST /runs/:runId/retry.
//
// Verifies:
//   - Owner retrying a failed run → 202, enqueueStep spy called with the
//     failed step, response body contains retried step names.
//   - Non-owner → 403, enqueueStep not called.
//   - Retrying a non-failed run → 400, enqueueStep not called.
//   - No Stripe client is injected — the endpoint would 500 if it touched Stripe.
//
// Uses the same pattern as authRoutes.test.ts: a real DB, fake JwtVerifier,
// injectable enqueueStep spy, no BullMQ/Redis/Supabase required.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import type { JwtVerifier } from "../../middleware/auth";
import * as checkpoint from "../checkpoint.repository";

// ── Fake identities ───────────────────────────────────────────────────────────

const AUTH_USER_A = "dddddddd-0000-4000-a000-000000000001";
const AUTH_USER_B = "eeeeeeee-0000-4000-a000-000000000002";
const TOKEN_A     = "retry-run-token-a";
const TOKEN_B     = "retry-run-token-b";

const fakeVerifyJwt: JwtVerifier = async (jwt) => {
  if (jwt === TOKEN_A) return AUTH_USER_A;
  if (jwt === TOKEN_B) return AUTH_USER_B;
  return null;
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function httpPost(
  port: number,
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const createdFounderIds: string[] = [];
const createdRunIds: string[] = [];

async function makeFounder(authUserId: string): Promise<string> {
  const f = await prisma.founder.create({
    data: {
      authUserId,
      expertise: [],
      industries: [],
      distributionAssets: [],
      audienceAssets: [],
      constraints: [],
    },
  });
  createdFounderIds.push(f.id);
  return f.id;
}

async function makeFailedRun(founderId: string): Promise<string> {
  const run = await prisma.pipelineRun.create({
    data: { founderId, vertical: "shopify_subscriptions" },
  });
  createdRunIds.push(run.runId);
  await checkpoint.upsertPending({ runId: run.runId, step: "discovery" });
  await checkpoint.markFailedPermanent(run.runId, "discovery", "max_tokens exceeded — injected for retry test");
  return run.runId;
}

async function makeQueuedRun(founderId: string): Promise<string> {
  const run = await prisma.pipelineRun.create({
    data: { founderId, vertical: "shopify_subscriptions" },
  });
  createdRunIds.push(run.runId);
  // No checkpoints → all not_started → deriveOverallStatus returns "queued"
  return run.runId;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("POST /runs/:runId/retry", () => {
  let port: number;
  let server: http.Server;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let enqueueStepSpy: ReturnType<typeof vi.fn>;
  let founderAId: string;
  let founderBId: string;
  let failedRunId: string;
  let queuedRunId: string;

  beforeAll(async () => {
    enqueueStepSpy = vi.fn().mockResolvedValue({ enqueued: true });

    const app = createApp({
      verifyJwt: fakeVerifyJwt,
      enqueueStep: enqueueStepSpy as unknown as (step: import("../steps").DagStep, data: import("../handlers").JobData) => Promise<{ enqueued: boolean; reason?: string }>,
      // No stripe injected — endpoint must not touch it
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;

    founderAId = await makeFounder(AUTH_USER_A);
    founderBId = await makeFounder(AUTH_USER_B);
    failedRunId = await makeFailedRun(founderAId);
    queuedRunId = await makeQueuedRun(founderAId);
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.founder.deleteMany({ where: { id: { in: createdFounderIds } } });
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });

  beforeEach(() => {
    enqueueStepSpy.mockClear();
  });

  it("non-owner → 403, enqueueStep not called", async () => {
    const res = await httpPost(port, `/runs/${failedRunId}/retry`, {}, TOKEN_B);
    expect(res.status).toBe(403);
    expect(enqueueStepSpy).not.toHaveBeenCalled();
  });

  it("retrying a non-failed (queued) run → 400, enqueueStep not called", async () => {
    const res = await httpPost(port, `/runs/${queuedRunId}/retry`, {}, TOKEN_A);
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>).error).toMatch(/only 'failed' runs/);
    expect(enqueueStepSpy).not.toHaveBeenCalled();
  });

  it("owner retrying a failed run → 202, enqueueStep called with the failed step", async () => {
    const res = await httpPost(port, `/runs/${failedRunId}/retry`, {}, TOKEN_A);
    expect(res.status).toBe(202);
    const body = res.body as { runId: string; retried: string[] };
    expect(body.runId).toBe(failedRunId);
    expect(body.retried).toContain("discovery");
    expect(enqueueStepSpy).toHaveBeenCalledWith(
      "discovery",
      expect.objectContaining({ runId: failedRunId })
    );
    // No Stripe: spy was called exactly once (the re-enqueue) with no checkout args
    expect(enqueueStepSpy).toHaveBeenCalledTimes(1);
  });
});
