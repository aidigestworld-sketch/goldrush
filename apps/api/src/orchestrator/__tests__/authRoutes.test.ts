// Integration tests for auth middleware + per-route ownership.
// Covers the 403-on-non-owner check across all 7 routes.
//
// Uses a fake JwtVerifier (no real Supabase) and an enqueueStep no-op
// (no real BullMQ/Redis) — requires only a live Prisma DB connection.
// Run standalone: npx dotenv -e .env -- tsx src/orchestrator/__tests__/authRoutes.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import type { JwtVerifier } from "../../middleware/auth";
import * as checkpoint from "../checkpoint.repository";

// ── Fake identities ───────────────────────────────────────────────────────────

const AUTH_USER_A      = "aaaaaaaa-0000-0000-0000-000000000001";
const AUTH_USER_B      = "bbbbbbbb-0000-0000-0000-000000000002";
const AUTH_USER_ORPHAN = "cccccccc-0000-0000-0000-000000000003";

const TOKEN_A       = "test-token-a";
const TOKEN_B       = "test-token-b";
const TOKEN_ORPHAN  = "test-token-orphan";
const TOKEN_INVALID = "test-token-invalid";

const fakeVerifyJwt: JwtVerifier = async (jwt) => {
  if (jwt === TOKEN_A)      return AUTH_USER_A;
  if (jwt === TOKEN_B)      return AUTH_USER_B;
  if (jwt === TOKEN_ORPHAN) return AUTH_USER_ORPHAN;
  return null;
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function httpGet(port: number, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    http.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
      });
    }).on("error", reject).end();
  });
}

async function httpPost(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; body: unknown }> {
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
const createdCheckpointRunIds: string[] = [];

async function makeFounder(authUserId: string): Promise<string> {
  const f = await prisma.founder.create({
    data: { authUserId, expertise: [], industries: [], distributionAssets: [], audienceAssets: [], constraints: [] },
  });
  createdFounderIds.push(f.id);
  return f.id;
}

async function makeRun(founderId: string): Promise<string> {
  const r = await prisma.pipelineRun.create({ data: { founderId, vertical: "auth-test-vertical" } });
  createdRunIds.push(r.runId);
  return r.runId;
}

async function cleanup() {
  if (createdCheckpointRunIds.length > 0)
    await prisma.dagRunState.deleteMany({ where: { runId: { in: createdCheckpointRunIds } } });
  if (createdRunIds.length > 0)
    await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
  if (createdFounderIds.length > 0)
    await prisma.founder.deleteMany({ where: { id: { in: createdFounderIds } } });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("auth routes", () => {
  let port: number;
  let server: http.Server;
  let founderAId: string;
  let founderBId: string;
  let runAId: string;
  let hypothesisId: string;

  beforeAll(async () => {
    const app = createApp({
      verifyJwt: fakeVerifyJwt,
      enqueueStep: async () => ({ enqueued: true }),
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;

    founderAId = await makeFounder(AUTH_USER_A);
    founderBId = await makeFounder(AUTH_USER_B);
    runAId = await makeRun(founderAId);

    // Hypothesis checkpoint used by the last three describe blocks.
    hypothesisId = "a1a1a1a1-0000-0000-0000-" + runAId.replace(/-/g, "").slice(0, 12);
    await checkpoint.upsertPending({ runId: runAId, step: "discovery", hypothesisId });
    createdCheckpointRunIds.push(runAId);
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });

  // ── Auth middleware ──────────────────────────────────────────────────────────

  describe("auth middleware", () => {
    it("missing token → 401 with 'missing token' error", async () => {
      const res = await httpGet(port, `/founders/00000000-0000-0000-0000-000000000001/runs`);
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe("missing token");
    });

    it("invalid token → 401 with 'invalid token' error", async () => {
      const res = await httpGet(port, `/founders/00000000-0000-0000-0000-000000000001/runs`, TOKEN_INVALID);
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe("invalid token");
    });

    it("valid user with no founder row → 401 with 'no founder account' error", async () => {
      const res = await httpGet(port, `/founders/00000000-0000-0000-0000-000000000001/runs`, TOKEN_ORPHAN);
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe("no founder account");
    });

    it("/auth/session without token → 401 from its own guard (not middleware)", async () => {
      const res = await httpGet(port, `/auth/session`);
      expect(res.status).toBe(401);
      expect((res.body as Record<string, unknown>).error).toBe("missing token");
    });
  });

  // ── Per-route ownership ──────────────────────────────────────────────────────

  describe("GET /founders/:id/runs ownership", () => {
    it("owner → 200", async () => {
      const res = await httpGet(port, `/founders/${founderAId}/runs`, TOKEN_A);
      expect(res.status).toBe(200);
    });

    it("non-owner → 403", async () => {
      const res = await httpGet(port, `/founders/${founderAId}/runs`, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /runs/:runId/status ownership", () => {
    it("owner → 200", async () => {
      const res = await httpGet(port, `/runs/${runAId}/status`, TOKEN_A);
      expect(res.status).toBe(200);
    });

    it("non-owner → 403", async () => {
      const res = await httpGet(port, `/runs/${runAId}/status`, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /runs/:runId/result ownership", () => {
    it("owner → 200", async () => {
      const res = await httpGet(port, `/runs/${runAId}/result`, TOKEN_A);
      expect(res.status).toBe(200);
    });

    it("non-owner → 403", async () => {
      const res = await httpGet(port, `/runs/${runAId}/result`, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /hypotheses/:id/status ownership", () => {
    it("owner → 200", async () => {
      const res = await httpGet(port, `/hypotheses/${hypothesisId}/status`, TOKEN_A);
      expect(res.status).toBe(200);
    });

    it("non-owner → 403", async () => {
      const res = await httpGet(port, `/hypotheses/${hypothesisId}/status`, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /hypotheses/:id/orchestrate ownership", () => {
    beforeAll(async () => {
      // Advance checkpoint to running so the orchestrate handler's
      // "already running" short-circuit returns 200 without touching enqueueStep.
      await checkpoint.markRunning(runAId, "discovery");
    });

    it("owner resuming own run → 200", async () => {
      const res = await httpPost(port, `/hypotheses/${hypothesisId}/orchestrate`, {}, TOKEN_A);
      expect(res.status).toBe(200);
    });

    it("non-owner → 403", async () => {
      const res = await httpPost(port, `/hypotheses/${hypothesisId}/orchestrate`, {}, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /hypotheses/:id/steps/:step/retry ownership", () => {
    beforeAll(async () => {
      // resetForRetry only accepts failed_permanent rows.
      await checkpoint.markFailedPermanent(runAId, "discovery", "injected-for-retry-test");
    });

    it("owner retrying own step → 202", async () => {
      const res = await httpPost(port, `/hypotheses/${hypothesisId}/steps/discovery/retry`, {}, TOKEN_A);
      expect(res.status).toBe(202);
    });

    it("non-owner → 403", async () => {
      const res = await httpPost(port, `/hypotheses/${hypothesisId}/steps/discovery/retry`, {}, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /runs/:runId/retry ownership", () => {
    let retryRunId: string;

    beforeAll(async () => {
      retryRunId = (await prisma.pipelineRun.create({
        data: { founderId: founderAId, vertical: "auth-test-vertical" },
      })).runId;
      createdRunIds.push(retryRunId);
      await checkpoint.upsertPending({ runId: retryRunId, step: "discovery" });
      await checkpoint.markFailedPermanent(retryRunId, "discovery", "injected-for-auth-retry-test");
      createdCheckpointRunIds.push(retryRunId);
    });

    it("owner retrying own failed run → 202", async () => {
      const res = await httpPost(port, `/runs/${retryRunId}/retry`, {}, TOKEN_A);
      expect(res.status).toBe(202);
    });

    it("non-owner → 403", async () => {
      const res = await httpPost(port, `/runs/${retryRunId}/retry`, {}, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /founders/:id/intake/turn ownership", () => {
    it("owner posting to own intake turn → 200", async () => {
      const res = await httpPost(port, `/founders/${founderAId}/intake/turn`, {}, TOKEN_A);
      expect(res.status).toBe(200);
    });

    it("non-owner → 403", async () => {
      const res = await httpPost(port, `/founders/${founderAId}/intake/turn`, {}, TOKEN_B);
      expect(res.status).toBe(403);
    });
  });
});
