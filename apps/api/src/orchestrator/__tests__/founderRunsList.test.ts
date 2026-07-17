import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import * as checkpoint from "../checkpoint.repository";

const TAG = "test-founder-runs-";
const AUTH_USER_NEW = "11111111-0000-0000-0000-000000000001";
const AUTH_USER_A   = "22222222-0000-0000-0000-000000000002";
const AUTH_USER_B   = "33333333-0000-0000-0000-000000000003";
const TOKEN_NEW = "runs-test-token-new";
const TOKEN_A   = "runs-test-token-a";
const TOKEN_B   = "runs-test-token-b";

const fakeVerifyJwt = async (jwt: string): Promise<string | null> => {
  if (jwt === TOKEN_NEW) return AUTH_USER_NEW;
  if (jwt === TOKEN_A)   return AUTH_USER_A;
  if (jwt === TOKEN_B)   return AUTH_USER_B;
  return null;
};

async function httpGet(port: number, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      }
    ).on("error", reject).end();
  });
}

const createdRunIds: string[] = [];
const createdFounderIds: string[] = [];
const createdCandidateIds: string[] = [];
const createdOpportunityIds: string[] = [];

async function makeRun(founderId: string, vertical: string): Promise<string> {
  const run = await prisma.pipelineRun.create({ data: { founderId, vertical, status: "running" } });
  createdRunIds.push(run.runId);
  return run.runId;
}

async function makeFounder(authUserId: string): Promise<string> {
  const f = await prisma.founder.create({ data: { authUserId, expertise: [], industries: [], constraints: [] } });
  createdFounderIds.push(f.id);
  return f.id;
}

async function seedPromotedOpportunity(runId: string): Promise<string> {
  // Realistic scales: founderFitScore is stored 0-100 (per FounderFit
  // sandbox schema); ventureScore + confidenceScore are 0-1. The API
  // normalises founderFitScore to 0-1 at the boundary so the frontend
  // can render all three scores with the same uniform (value * 100)%
  // formula.
  const candidate = await prisma.opportunityCandidate.create({
    data: { runId, ventureScore: 0.82, founderFitScore: 71, confidenceScore: 0.68, status: "promoted" },
  });
  createdCandidateIds.push(candidate.id);
  const opp = await prisma.opportunity.create({
    data: {
      promotedFromCandidateId: candidate.id,
      ventureScore: 0.82, founderFitScore: 71, confidenceScore: 0.68,
      rationaleBullets: ["Strong market pull in underserved segment", "Defensible distribution"],
      riskSummary: ["Regulatory uncertainty"],
    },
  });
  createdOpportunityIds.push(opp.id);
  return opp.id;
}

async function cleanup() {
  if (createdOpportunityIds.length > 0)
    await prisma.opportunity.deleteMany({ where: { id: { in: createdOpportunityIds } } });
  if (createdCandidateIds.length > 0)
    await prisma.opportunityCandidate.deleteMany({ where: { id: { in: createdCandidateIds } } });
  if (createdRunIds.length > 0) {
    await prisma.dagRunState.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
  }
  if (createdFounderIds.length > 0)
    await prisma.founder.deleteMany({ where: { id: { in: createdFounderIds } } });
}

describe("GET /founders/:id/runs", () => {
  let port: number;
  let server: http.Server;
  let founderNew: string, founderA: string, founderB: string;
  let runA1: string, runA2: string, runB1: string;

  beforeAll(async () => {
    const app = createApp({ verifyJwt: fakeVerifyJwt, enqueueStep: async () => ({ enqueued: true }) });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
    founderNew = await makeFounder(AUTH_USER_NEW);
    founderA   = await makeFounder(AUTH_USER_A);
    founderB   = await makeFounder(AUTH_USER_B);
    runA1 = await makeRun(founderA, TAG + "vertical-a1");
    runA2 = await makeRun(founderA, TAG + "vertical-a2");
    runB1 = await makeRun(founderB, TAG + "vertical-b1");
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });

  it("empty list: 200 [] for new founder with no runs", async () => {
    const res = await httpGet(port, `/founders/${founderNew}/runs`, TOKEN_NEW);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body) && (res.body as unknown[]).length === 0).toBe(true);
  });

  it("scoping isolation: founderA sees only A runs; founderB sees only B runs", async () => {
    const resA = await httpGet(port, `/founders/${founderA}/runs`, TOKEN_A);
    expect(resA.status).toBe(200);
    const bodyA = resA.body as Array<Record<string, unknown>>;
    expect(Array.isArray(bodyA)).toBe(true);
    const runIdsA = bodyA.map((r) => r.runId);
    expect(runIdsA.includes(runA1)).toBe(true);
    expect(runIdsA.includes(runA2)).toBe(true);
    expect(runIdsA.includes(runB1)).toBe(false);
    expect(bodyA.length).toBe(2);

    const resB = await httpGet(port, `/founders/${founderB}/runs`, TOKEN_B);
    const bodyB = resB.body as Array<Record<string, unknown>>;
    const runIdsB = bodyB.map((r) => r.runId);
    expect(runIdsB.includes(runB1)).toBe(true);
    expect(runIdsB.includes(runA1)).toBe(false);
    expect(runIdsB.includes(runA2)).toBe(false);
    expect(bodyB.length).toBe(1);
  });

  it("ordering: newest run (runA2) is first", async () => {
    const res = await httpGet(port, `/founders/${founderA}/runs`, TOKEN_A);
    const body = res.body as Array<Record<string, unknown>>;
    expect(body[0].runId).toBe(runA2);
    expect(body[1].runId).toBe(runA1);
  });

  it("overall status: no checkpoints → queued; pending → in_progress; failed_permanent → failed", async () => {
    const resInit = await httpGet(port, `/founders/${founderA}/runs`, TOKEN_A);
    const bodyInit = resInit.body as Array<Record<string, unknown>>;
    expect(bodyInit.find((r) => r.runId === runA1)?.overall).toBe("queued");

    const hypothesisId = "a2a2a2a2-0000-0000-0000-000000000001";
    await checkpoint.upsertPending({ runId: runA2, step: "discovery", hypothesisId });
    const resInProgress = await httpGet(port, `/founders/${founderA}/runs`, TOKEN_A);
    const bodyInProgress = resInProgress.body as Array<Record<string, unknown>>;
    expect(bodyInProgress.find((r) => r.runId === runA2)?.overall).toBe("in_progress");

    await checkpoint.markRunning(runA2, "discovery");
    await checkpoint.markFailedPermanent(runA2, "discovery", "timed out");
    const resFailed = await httpGet(port, `/founders/${founderA}/runs`, TOKEN_A);
    const bodyFailed = resFailed.body as Array<Record<string, unknown>>;
    expect(bodyFailed.find((r) => r.runId === runA2)?.overall).toBe("failed");
  });

  it("promoted opportunity: completed run has non-null opportunity; non-promoted run has opportunity=null; response shape fields correct", async () => {
    const runC = await makeRun(founderA, TAG + "vertical-c");
    await seedPromotedOpportunity(runC);
    for (const step of [
      "discovery", "expansion", "filtering", "competitive_analysis", "hypothesis",
      "validation", "confidence_mode1", "composition", "scoring",
      "confidence_mode2", "founder_fit", "compression",
    ] as const) {
      await checkpoint.upsertPending({ runId: runC, step, hypothesisId: "a2a2a2a2-0000-0000-0000-000000000002" });
      await checkpoint.markRunning(runC, step);
      await checkpoint.markSucceeded(runC, step);
    }

    const resC = await httpGet(port, `/founders/${founderA}/runs`, TOKEN_A);
    const bodyC = resC.body as Array<Record<string, unknown>>;
    const runCEntry = bodyC.find((r) => r.runId === runC) as Record<string, unknown> | undefined;

    expect(runCEntry).toBeDefined();
    expect(runCEntry?.overall).toBe("completed");
    expect(runCEntry?.opportunity).not.toBeNull();

    const opp = runCEntry?.opportunity as Record<string, unknown> | null;
    // Regression for the 4000% display bug (seen in prod for run
    // f17f7c6d with a stored founderFitScore=40 rendering as 4000%
    // via the frontend's uniform value*100 formatter). The API
    // MUST normalise the DB's 0-100 scale to 0-1 at this boundary.
    // Seed above stores 71 → API MUST return 0.71.
    expect(opp?.ventureScore).toBe(0.82);
    expect(opp?.confidenceScore).toBe(0.68);
    expect(opp?.founderFitScore).toBeCloseTo(0.71, 5);
    expect(opp?.headline).toBe("Strong market pull in underserved segment");

    const runA1Entry = bodyC.find((r) => r.runId === runA1) as Record<string, unknown> | undefined;
    expect(runA1Entry?.opportunity).toBeNull();

    // Response shape fields
    if (runCEntry) {
      expect("runId" in runCEntry).toBe(true);
      expect("vertical" in runCEntry).toBe(true);
      expect("createdAt" in runCEntry).toBe(true);
      expect("overall" in runCEntry).toBe(true);
      expect("opportunity" in runCEntry).toBe(true);
      expect(runCEntry.vertical).toBe(TAG + "vertical-c");
    }
  });
});
