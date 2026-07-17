// Contract tests for GET /runs/:runId/result — the endpoint that powers
// the result view. Three distinct response shapes are exercised:
//
//   (1) Promoted opportunity   → opportunity present + candidates array
//                                includes the promoted row
//   (2) Evaluated but not      → opportunity null, candidates array holds
//       promoted                 real scored detail incl. deprecationReason
//                                and founder-fit rationale
//   (3) Zero candidates ever   → opportunity null, candidates empty (no
//       composed                 fabricated per-candidate detail)
//
// Fixture (2) uses the aae43d53 real-run numbers verbatim (oq 0.46,
// conf 1.0, founderFitScore stored 20 → normalised 0.20, ventureScore
// null because the min-fit gate blocked venture calc, deprecationReason
// "failed_gate"). If someone regresses the founderFitScore/100
// normalisation on this new endpoint, the "0.20 vs 20" assertion here
// catches it before anything ships to the frontend.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import * as checkpoint from "../checkpoint.repository";
import { DAG_STEPS } from "../steps";

const AUTH_USER = "44444444-0000-0000-0000-000000000004";
const TOKEN = "result-endpoint-token";
const fakeVerifyJwt = async (jwt: string): Promise<string | null> =>
  jwt === TOKEN ? AUTH_USER : null;

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

async function markAllStepsSucceeded(runId: string, hypothesisId: string) {
  for (const step of DAG_STEPS) {
    await checkpoint.upsertPending({ runId, step, hypothesisId });
    await checkpoint.markRunning(runId, step);
    await checkpoint.markSucceeded(runId, step);
  }
}

describe("GET /runs/:runId/result", () => {
  let port: number;
  let server: http.Server;
  let founderId: string;

  beforeAll(async () => {
    const app = createApp({ verifyJwt: fakeVerifyJwt, enqueueStep: async () => ({ enqueued: true }) });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
    const founder = await prisma.founder.create({
      data: { authUserId: AUTH_USER, expertise: [], industries: [], constraints: [] },
    });
    createdFounderIds.push(founder.id);
    founderId = founder.id;
  });

  afterAll(async () => {
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
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });

  it("(1) promoted opportunity: opportunity populated, candidates array includes promoted row with 0-1 normalised scores", async () => {
    const run = await prisma.pipelineRun.create({
      data: { founderId, vertical: "test-promoted", status: "completed" },
    });
    createdRunIds.push(run.runId);
    await markAllStepsSucceeded(run.runId, "aaaaaaaa-0000-0000-0000-000000000001");

    // Seed a promoted candidate: founderFitScore stored 71 (0-100 scale).
    const cand = await prisma.opportunityCandidate.create({
      data: {
        runId: run.runId,
        opportunityQuality: 0.72,
        confidenceScore: 0.74,
        founderFitScore: 71, // 0-100 → 0.71 after API normalisation
        ventureScore: 0.82,
        founderFitRationale: "Deep domain match",
        status: "promoted",
      },
    });
    createdCandidateIds.push(cand.id);
    const opp = await prisma.opportunity.create({
      data: {
        promotedFromCandidateId: cand.id,
        ventureScore: 0.82,
        confidenceScore: 0.74,
        founderFitScore: 71,
        founderFitRationale: "Deep domain match",
        rationaleBullets: ["Winner bullet 1"],
        riskSummary: ["Risk 1"],
      },
    });
    createdOpportunityIds.push(opp.id);

    const res = await httpGet(port, `/runs/${run.runId}/result`, TOKEN);
    expect(res.status).toBe(200);
    const body = res.body as {
      overall: string; runStatus: string;
      opportunity: { founderFitScore: number; ventureScore: number; confidenceScore: number; rationaleBullets: string[] } | null;
      candidates: Array<{ status: string; founderFitScore: number | null; ventureScore: number | null; deprecationReason: string | null }>;
    };
    expect(body.overall).toBe("completed");
    expect(body.runStatus).toBe("completed");
    expect(body.opportunity).not.toBeNull();
    expect(body.opportunity!.founderFitScore).toBeCloseTo(0.71, 5);
    expect(body.opportunity!.ventureScore).toBe(0.82);
    expect(body.candidates.length).toBe(1);
    expect(body.candidates[0].status).toBe("promoted");
    expect(body.candidates[0].founderFitScore).toBeCloseTo(0.71, 5);
    expect(body.candidates[0].deprecationReason).toBeNull();
  });

  it("(2) evaluated but not promoted (aae43d53 fixture): opportunity null, candidates carry real scored detail incl. gate reason + rationale", async () => {
    const run = await prisma.pipelineRun.create({
      data: { founderId, vertical: "test-eval-not-promoted", status: "insufficient_evidence" },
    });
    createdRunIds.push(run.runId);
    await markAllStepsSucceeded(run.runId, "aaaaaaaa-0000-0000-0000-000000000002");

    // aae43d53's actual numbers: oq=0.46, conf=1.0, founderFitScore=20 (0-100 scale),
    // ventureScore=null (min-fit gate), deprecationReason=failed_gate.
    const cand = await prisma.opportunityCandidate.create({
      data: {
        runId: run.runId,
        opportunityQuality: 0.46,
        confidenceScore: 1.0,
        founderFitScore: 20, // 0-100 → 0.20 after API normalisation
        ventureScore: null,
        founderFitRationale:
          "Founder's background is in adjacent SaaS but lacks direct experience with subscription-billing merchants.",
        status: "deprecated",
        deprecationReason: "failed_gate",
        confidenceCoverageGate: true,
        incompleteComposition: false,
      },
    });
    createdCandidateIds.push(cand.id);

    const res = await httpGet(port, `/runs/${run.runId}/result`, TOKEN);
    expect(res.status).toBe(200);
    const body = res.body as {
      overall: string; runStatus: string;
      opportunity: unknown | null;
      candidates: Array<{
        id: string; status: string;
        opportunityQuality: number | null; confidenceScore: number | null;
        founderFitScore: number | null; ventureScore: number | null;
        founderFitRationale: string | null; deprecationReason: string | null;
        confidenceCoverageGate: boolean | null; incompleteComposition: boolean | null;
      }>;
    };
    expect(body.overall).toBe("completed");
    // pipeline_run.status surfaces the "insufficient_evidence" distinction
    // that plain `overall` collapses into "completed".
    expect(body.runStatus).toBe("insufficient_evidence");
    expect(body.opportunity).toBeNull();
    expect(body.candidates.length).toBe(1);

    const c = body.candidates[0];
    expect(c.status).toBe("deprecated");
    expect(c.opportunityQuality).toBeCloseTo(0.46, 5);
    expect(c.confidenceScore).toBeCloseTo(1.0, 5);
    // The load-bearing assertion: stored 20 must arrive as 0.20 (not 20,
    // which would render as 2000% in the ScoreChip; not 0.002 which would
    // be a double-divide regression).
    expect(c.founderFitScore).toBeCloseTo(0.20, 5);
    expect(c.ventureScore).toBeNull();
    expect(c.deprecationReason).toBe("failed_gate");
    expect(c.founderFitRationale).toContain("adjacent SaaS");
    expect(c.confidenceCoverageGate).toBe(true);
    expect(c.incompleteComposition).toBe(false);
  });

  it("(3) zero candidates ever composed: opportunity null, candidates empty (no fabricated detail)", async () => {
    const run = await prisma.pipelineRun.create({
      data: { founderId, vertical: "test-no-candidates", status: "insufficient_evidence" },
    });
    createdRunIds.push(run.runId);
    await markAllStepsSucceeded(run.runId, "aaaaaaaa-0000-0000-0000-000000000003");

    const res = await httpGet(port, `/runs/${run.runId}/result`, TOKEN);
    expect(res.status).toBe(200);
    const body = res.body as {
      overall: string; runStatus: string;
      opportunity: unknown | null;
      candidates: unknown[];
    };
    expect(body.overall).toBe("completed");
    expect(body.runStatus).toBe("insufficient_evidence");
    expect(body.opportunity).toBeNull();
    expect(body.candidates).toEqual([]);
  });

  it("in-progress run: candidates always [] (endpoint only queries when overall==='completed')", async () => {
    const run = await prisma.pipelineRun.create({
      data: { founderId, vertical: "test-in-progress", status: "running" },
    });
    createdRunIds.push(run.runId);
    // NO step markings — DAG has no rows → overall === "queued"
    const res = await httpGet(port, `/runs/${run.runId}/result`, TOKEN);
    expect(res.status).toBe(200);
    const body = res.body as {
      overall: string; opportunity: unknown | null; candidates: unknown[];
    };
    expect(body.overall).toBe("queued");
    expect(body.opportunity).toBeNull();
    expect(body.candidates).toEqual([]);
  });
});
