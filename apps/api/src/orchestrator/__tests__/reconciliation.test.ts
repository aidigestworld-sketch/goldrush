// Regression tests for reconciliation. Two shapes of split-brain the
// reconciler must catch:
//
//   A) DB status='running' past STALE_THRESHOLD_MS, NO BullMQ job at all
//      → the "worker died mid-attempt before recordAttemptError" case
//      (SIGKILL, OOM, Docker restart). Time-based fallback fires.
//
//   B) DB status IN ('pending', 'running'), BullMQ job present but in
//      TERMINAL state (failed/completed). The 13:02:44 UTC 2026-07-15
//      incident: recordAttemptError ran (row → 'pending') but
//      markFailedPermanent didn't (process killed in the 4ms window).
//      State-driven mirroring fires: BullMQ 'failed' → DB
//      'failed_permanent' + pipeline_run.status='failed'.
//
// Tests stub the queues module via vi.doMock so we don't need a live
// Redis. The stubbed getQueue returns a mocked queue with a getJob
// method that returns a mocked Job (with getState + failedReason).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../db/client";
import { STALE_THRESHOLD_MS } from "../reconciliation";
import { resetForRetry } from "../checkpoint.repository";

const RUN_ID = "f867b348-3333-4000-a000-000000000030";
const AUTH_USER_ID = "f867b348-3333-4000-a000-000000000031";
const OLD_STARTED_AT = new Date(Date.now() - STALE_THRESHOLD_MS - 60_000); // 1 min past threshold
const FRESH_STARTED_AT = new Date(Date.now() - 60_000); // 1 min ago

type FakeJobShape = { state: "waiting" | "active" | "delayed" | "failed" | "completed" | "waiting-children"; failedReason?: string };
type StubBehavior =
  | { job: FakeJobShape }
  | { noJob: true }
  | { throws: Error };

describe("reconciliation — state-driven + time-fallback", () => {
  let founderId: string;

  beforeAll(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
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
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.deleteMany({ where: { runId: RUN_ID } });
    await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_ID } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.dagRunState.deleteMany({ where: { runId: RUN_ID } });
    await prisma.pipelineRun.update({ where: { runId: RUN_ID }, data: { status: "running" } });
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../queues");
  });

  async function loadReconcilerWithStubbedQueue(behavior: StubBehavior) {
    vi.doMock("../queues", () => {
      const fakeQueue = {
        getJob: async (_jobId: string) => {
          if ("throws" in behavior) throw behavior.throws;
          if ("noJob" in behavior) return null;
          const { job } = behavior;
          return {
            getState: async () => job.state,
            failedReason: job.failedReason ?? null,
          };
        },
      };
      return {
        DEFAULT_JOB_OPTIONS: { attempts: 3 },
        getQueue: () => fakeQueue,
      };
    });
    const mod = await import("../reconciliation");
    return mod.reconcileStuckRunningSteps;
  }

  // ─── B) State-driven mirroring: the ba923046 / c5c1fcdc pattern ───

  it("DB='pending' + BullMQ='failed' → mirrors to failed_permanent + pipeline_run.status='failed' (the c5c1fcdc split-brain)", async () => {
    // Exact reproduction of the c5c1fcdc-c847-4a6c-9400-61482465cdad
    // state: recordAttemptError committed row='pending' with attempt
    // count and lastError, but markFailedPermanent never ran because
    // the process was killed between the two awaits.
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "pending",
        attemptCount: 3,
        lastError: "Error: NIM API error: 504",
        startedAt: FRESH_STARTED_AT, // even fresh — state-driven doesn't care about time
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({
      job: { state: "failed", failedReason: "NIM API error (model=...): 504" },
    });
    const result = await reconcile();

    // scanned counts ALL pending/running rows in the DB (including any
    // pre-existing dev-DB rows) — we care about the specific one we seeded.
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.reconciledFailed).toBeGreaterThanOrEqual(1);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("failed_permanent");
    // BullMQ's failedReason is preserved so triage sees the actual reason.
    expect(row?.lastError).toContain("NIM API error");
    expect(row?.lastError).toContain("BullMQ's failedReason");
    // Prior DB lastError also preserved.
    expect(row?.lastError).toContain("Prior lastError from DB");

    const run = await prisma.pipelineRun.findUnique({ where: { runId: RUN_ID } });
    expect(run?.status).toBe("failed");

    // Retryable via the UI — the core reason this fix exists.
    const reset = await resetForRetry(RUN_ID, "validation");
    expect(reset.status).toBe("pending");
  });

  it("DB='running' + BullMQ='failed' → mirrors to failed_permanent (fresh startedAt doesn't matter for state-driven path)", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "running",
        attemptCount: 3,
        startedAt: FRESH_STARTED_AT,
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({
      job: { state: "failed", failedReason: "some error" },
    });
    const result = await reconcile();
    expect(result.reconciledFailed).toBe(1);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("failed_permanent");
  });

  it("DB='pending' + BullMQ='completed' → mirrors to succeeded (defensive)", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "pending",
        attemptCount: 1,
        startedAt: FRESH_STARTED_AT,
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({
      job: { state: "completed" },
    });
    const result = await reconcile();
    expect(result.reconciledSucceeded).toBe(1);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("succeeded");
  });

  it("DB='running' + BullMQ='active' → leaves row alone (genuinely in flight)", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "running",
        attemptCount: 1,
        startedAt: OLD_STARTED_AT, // even OLD startedAt shouldn't matter if BullMQ says active
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({
      job: { state: "active" },
    });
    const result = await reconcile();
    expect(result.stillActive).toBe(1);
    expect(result.reconciledFailed).toBe(0);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("running"); // unchanged
  });

  it("DB='pending' + BullMQ='waiting' → leaves row alone (job hasn't been picked up yet, that's fine)", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "pending",
        attemptCount: 0,
        startedAt: FRESH_STARTED_AT,
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({
      job: { state: "waiting" },
    });
    const result = await reconcile();
    expect(result.stillActive).toBe(1);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("pending");
  });

  // ─── A) Time-based fallback: no BullMQ job at all ───

  it("DB='running' past threshold + NO BullMQ job → failed_permanent via time-based fallback", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "running",
        attemptCount: 3,
        lastError: "fetch failed",
        startedAt: OLD_STARTED_AT,
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({ noJob: true });
    const result = await reconcile();
    expect(result.crashedMidAttempt).toBe(1);
    expect(result.reconciledFailed).toBe(1);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("failed_permanent");
    expect(row?.lastError).toContain("worker process was killed mid-attempt");
    expect(row?.lastError).toContain("fetch failed"); // prior lastError preserved
  });

  it("DB='running' WITHIN threshold + NO BullMQ job → NOT touched (job may still be legitimately spinning up)", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "running",
        attemptCount: 1,
        startedAt: FRESH_STARTED_AT,
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({ noJob: true });
    const result = await reconcile();
    expect(result.reconciledFailed).toBe(0);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("running");
  });

  it("DB='pending' + NO BullMQ job → NOT touched (upstream may still be enqueueing this step)", async () => {
    // A 'pending' row without any BullMQ job is the legitimate "just
    // created, waiting to be enqueued" state — sequencing.ts's
    // enqueueStep upserts the row BEFORE adding the job. Never reconcile
    // this state via the time-based path.
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "pending",
        attemptCount: 0,
        startedAt: OLD_STARTED_AT, // even OLD — pending+no-job is always kept.
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({ noJob: true });
    const result = await reconcile();
    expect(result.reconciledFailed).toBe(0);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("pending");
  });

  it("Redis/queue lookup throws → reconciler leaves row alone (no false positive)", async () => {
    await prisma.dagRunState.create({
      data: {
        runId: RUN_ID,
        step: "validation",
        status: "pending",
        attemptCount: 3,
        startedAt: OLD_STARTED_AT,
      },
    });

    const reconcile = await loadReconcilerWithStubbedQueue({ throws: new Error("Redis unreachable") });
    const result = await reconcile();
    expect(result.reconciledFailed).toBe(0);

    const row = await prisma.dagRunState.findUnique({
      where: { runId_step: { runId: RUN_ID, step: "validation" } },
    });
    expect(row?.status).toBe("pending");
  });
});
