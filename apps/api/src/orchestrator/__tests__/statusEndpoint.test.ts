import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import * as checkpoint from "../checkpoint.repository";
import { deriveOverallStatus, buildStages } from "../api";
import { DAG_STEPS, FORK_CHILDREN, JOIN_STEP, STEP_LABELS } from "../steps";

const TAG = "test-status-ep-";
const AUTH_USER_TEST = "44444444-0000-0000-0000-000000000001";
const TOKEN_TEST = "status-test-token";
const fakeVerifyJwt = async (jwt: string): Promise<string | null> =>
  jwt === TOKEN_TEST ? AUTH_USER_TEST : null;

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

// ── Unit: deriveOverallStatus() ────────────────────────────────────────────────

describe("deriveOverallStatus()", () => {
  const allNotStarted = DAG_STEPS.map((step) => ({ step, status: "not_started" }));

  it('all not_started → "queued"', () => {
    expect(deriveOverallStatus(allNotStarted)).toBe("queued");
  });

  it('pending step → "in_progress"', () => {
    const withPending = allNotStarted.map((s) =>
      s.step === "discovery" ? { ...s, status: "pending" } : s
    );
    expect(deriveOverallStatus(withPending)).toBe("in_progress");
  });

  it('running step → "in_progress"', () => {
    const withRunning = allNotStarted.map((s) =>
      s.step === "expansion" ? { ...s, status: "running" } : s
    );
    expect(deriveOverallStatus(withRunning)).toBe("in_progress");
  });

  it('failed_permanent step → "failed"', () => {
    const withFailed = allNotStarted.map((s) =>
      s.step === "validation" ? { ...s, status: "failed_permanent" } : s
    );
    expect(deriveOverallStatus(withFailed)).toBe("failed");
  });

  it("failed_permanent takes precedence over running", () => {
    const failedAndRunning = allNotStarted
      .map((s) => (s.step === "validation" ? { ...s, status: "failed_permanent" } : s))
      .map((s) => (s.step === "discovery" ? { ...s, status: "running" } : s));
    expect(deriveOverallStatus(failedAndRunning)).toBe("failed");
  });

  it('all succeeded → "completed"', () => {
    const allSucceeded = DAG_STEPS.map((step) => ({ step, status: "succeeded" }));
    expect(deriveOverallStatus(allSucceeded)).toBe("completed");
  });

  it('join step succeeded → "completed"', () => {
    const joinOnly = allNotStarted.map((s) =>
      s.step === JOIN_STEP ? { ...s, status: "succeeded" } : s
    );
    expect(deriveOverallStatus(joinOnly)).toBe("completed");
  });

  // Empty-cascade case (ba923046 / emptyCascadeStatus.test.ts): every
  // step succeeds because Discovery skipped for lack of evidence, so
  // dag_run_state alone would derive "completed". pipeline_run.status
  // carries the actual terminal outcome ('insufficient_evidence') and
  // MUST surface distinctly — otherwise a paying founder sees a green
  // "Completed" badge on a run that produced nothing.
  it('join succeeded + pipelineRunStatus="insufficient_evidence" → "insufficient_evidence"', () => {
    const allSucceeded = DAG_STEPS.map((step) => ({ step, status: "succeeded" }));
    expect(deriveOverallStatus(allSucceeded, "insufficient_evidence")).toBe("insufficient_evidence");
  });

  it('join succeeded + pipelineRunStatus="completed" → "completed" (winner promoted)', () => {
    const allSucceeded = DAG_STEPS.map((step) => ({ step, status: "succeeded" }));
    expect(deriveOverallStatus(allSucceeded, "completed")).toBe("completed");
  });

  it("insufficient_evidence never overrides a still-running or failed run", () => {
    // Guard: the pipelineRunStatus override only kicks in when the join
    // step has actually succeeded. A stale pipeline_run.status column
    // from an earlier run shouldn't misclassify an in-progress or failed
    // step chain.
    const withRunning = allNotStarted.map((s) =>
      s.step === "discovery" ? { ...s, status: "running" } : s
    );
    expect(deriveOverallStatus(withRunning, "insufficient_evidence")).toBe("in_progress");

    const withFailed = allNotStarted.map((s) =>
      s.step === "validation" ? { ...s, status: "failed_permanent" } : s
    );
    expect(deriveOverallStatus(withFailed, "insufficient_evidence")).toBe("failed");
  });
});

// ── Unit: buildStages() topology ──────────────────────────────────────────────

describe("buildStages() topology", () => {
  const perStep = DAG_STEPS.map((step) => ({
    step,
    label: STEP_LABELS[step],
    status: "not_started",
    attemptCount: 0,
    lastError: null,
    startedAt: null,
    completedAt: null,
  }));
  const stages = buildStages(perStep);

  it(`last stage is ${JOIN_STEP}`, () => {
    const last = stages[stages.length - 1];
    expect(last.type === "step" && (last as { step: string }).step === JOIN_STEP).toBe(true);
  });

  it("second-to-last stage is type=fork with 2 branches containing FORK_CHILDREN", () => {
    const fork = stages[stages.length - 2];
    expect(fork.type).toBe("fork");
    if (fork.type === "fork") {
      const forkSteps = fork.branches.map((b) => b.step);
      expect(FORK_CHILDREN.every((fc) => forkSteps.includes(fc))).toBe(true);
      expect(fork.branches.length).toBe(2);

      const stepStages = stages.filter((s) => s.type === "step").map((s) => (s as { step: string }).step);
      for (const fc of FORK_CHILDREN) {
        expect(stepStages.includes(fc)).toBe(false);
      }
    }
  });

  it(`stage count = 11 (9 linear + 1 fork + 1 join)`, () => {
    const expectedCount = 9 + 1 + 1;
    expect(stages.length).toBe(expectedCount);
  });

  it("every step stage has a human-readable label different from the enum key", () => {
    const stepStages = stages.filter((s) => s.type === "step") as Array<{ step: string; label: string }>;
    expect(stepStages.every((s) => s.label && s.label !== s.step)).toBe(true);
  });

  it("fork branches have human-readable labels", () => {
    const forkStage = stages.find((s) => s.type === "fork") as { type: "fork"; branches: Array<{ label: string; step: string }> } | undefined;
    if (forkStage) {
      expect(forkStage.branches.every((b) => b.label && b.label !== b.step)).toBe(true);
    }
  });
});

// ── HTTP: GET /hypotheses/:id/status ──────────────────────────────────────────

describe("GET /hypotheses/:id/status", () => {
  let port: number;
  let server: http.Server;
  let testFounderId: string;
  let runId: string;
  let hypothesisId: string;

  beforeAll(async () => {
    const app = createApp({ verifyJwt: fakeVerifyJwt, enqueueStep: async () => ({ enqueued: true }) });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;

    const testFounder = await prisma.founder.create({
      data: { authUserId: AUTH_USER_TEST, expertise: [], industries: [], constraints: [] },
    });
    testFounderId = testFounder.id;

    const run = await prisma.pipelineRun.create({
      data: { founderId: testFounder.id, vertical: TAG + "ecomm" },
    });
    runId = run.runId;
    hypothesisId = "b1b1b1b1-0000-0000-0000-" + run.runId.replace(/-/g, "").slice(0, 12);

    await checkpoint.upsertPending({ runId, step: "discovery", hypothesisId });
    await checkpoint.markRunning(runId, "discovery");
    await checkpoint.markSucceeded(runId, "discovery");

    await checkpoint.upsertPending({ runId, step: "expansion", hypothesisId });
    await checkpoint.markRunning(runId, "expansion");

    await checkpoint.upsertPending({ runId, step: "validation", hypothesisId });
    await checkpoint.markRunning(runId, "validation");
    await checkpoint.markFailedPermanent(runId, "validation", "LLM timeout");
  });

  afterAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId } });
    await prisma.pipelineRun.delete({ where: { runId } });
    await prisma.founder.delete({ where: { id: testFounderId } });
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });

  it("returns 404 for unknown hypothesis (authenticated)", async () => {
    const missing = await httpGet(port, `/hypotheses/00000000-0000-0000-0000-000000000099/status`, TOKEN_TEST);
    expect(missing.status).toBe(404);
  });

  it("200 with correct run shape, overall=failed, fork stage, stage statuses", async () => {
    const res = await httpGet(port, `/hypotheses/${hypothesisId}/status`, TOKEN_TEST);
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    expect("run" in body).toBe(true);
    expect("stages" in body).toBe(true);

    const run2 = body.run as Record<string, unknown>;
    expect(run2.runId).toBe(runId);
    expect(run2.hypothesisId).toBe(hypothesisId);
    expect(run2.vertical).toBe(TAG + "ecomm");
    expect(run2.overall).toBe("failed");

    const stages = body.stages as Array<Record<string, unknown>>;
    expect(Array.isArray(stages)).toBe(true);

    const forkStage = stages.find((s) => s.type === "fork") as Record<string, unknown> | undefined;
    expect(forkStage).toBeDefined();
    if (forkStage) {
      const branches = forkStage.branches as Array<Record<string, unknown>>;
      expect(branches.length).toBe(2);
      const branchSteps = branches.map((b) => b.step);
      expect(branchSteps.includes("confidence_mode2")).toBe(true);
      expect(branchSteps.includes("founder_fit")).toBe(true);
      expect(branches.every((b) => b.status === "not_started")).toBe(true);
    }

    const lastStage = stages[stages.length - 1] as Record<string, unknown>;
    expect(lastStage.type === "step" && lastStage.step === "compression").toBe(true);

    const discoveryStage = stages.find(
      (s) => s.type === "step" && (s as Record<string, unknown>).step === "discovery"
    ) as Record<string, unknown> | undefined;
    expect(discoveryStage?.status).toBe("succeeded");
    expect(typeof discoveryStage?.label === "string" && discoveryStage.label !== "discovery").toBe(true);
    expect((discoveryStage?.attemptCount as number) >= 1).toBe(true);
    expect(discoveryStage?.completedAt).not.toBeNull();

    const expansionStage = stages.find(
      (s) => s.type === "step" && (s as Record<string, unknown>).step === "expansion"
    ) as Record<string, unknown> | undefined;
    expect(expansionStage?.status).toBe("running");

    const validationStage = stages.find(
      (s) => s.type === "step" && (s as Record<string, unknown>).step === "validation"
    ) as Record<string, unknown> | undefined;
    expect(validationStage?.status).toBe("failed_permanent");
    expect(validationStage?.lastError).toBe("LLM timeout");
  });
});
