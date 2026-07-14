// Express router for the Phase 6 Orchestrator endpoints. Mounted by
// the top-level HTTP server (src/api/server.ts).
//
// Endpoints:
//   POST /hypotheses/:id/orchestrate         — start or resume a run
//   GET  /hypotheses/:id/status              — per-step checkpoint status with DAG topology
//   POST /hypotheses/:id/steps/:step/retry   — re-enqueue a failed_permanent step
//   GET  /founders/:id/runs                  — list all pipeline_runs for a founder
//
// `:id` is a hypothesis id. The Orchestrator maps that to a pipeline_run
// via one of two paths:
//   (a) If a dag_run_state row exists with hypothesis_id=:id, that's
//       the run we resume.
//   (b) Otherwise, we create a new pipeline_run (needs founder_id +
//       vertical from a body) and start fresh.
//
// The endpoint is idempotent by (b) never being reached twice for the
// same hypothesis: once a run exists, subsequent calls hit (a).
//
// Auth: the GET endpoints have TODO stubs — search "TODO: auth" for the
// spots that need Supabase Auth wiring once it is set up.

import { Router, type Request, type Response } from "express";
import { prisma } from "../db/client";
import { makeAuthMiddleware, type JwtVerifier } from "../middleware/auth";
import * as checkpoint from "./checkpoint.repository";
import { enqueueStep, resumeFromCheckpoint } from "./sequencing";
import type { JobData } from "./handlers";
import {
  DAG_STEPS,
  STEP_LABELS,
  LINEAR_ORDER,
  FORK_CHILDREN,
  JOIN_STEP,
  type DagStep,
} from "./steps";
import type { StripeClient } from "../stripe/types";
import { getStripe } from "../stripe/client";
import { ALLOWED_VERTICALS } from "./verticals";
import {
  emptyIntakeState,
  recordFieldAsked,
  recordFollowUpAsked,
  recordFieldAnswer,
  addContradictionFlag,
  detectContradiction,
  forceCompleteByCapTermination,
  markIntakeComplete,
  type FounderIntakeState,
  type FounderProfile,
  type MustFillField,
  type ContradictionFlag,
} from "../intake/founderIntakeState";
import { nextQuestion, QUESTIONS } from "../intake/founderIntakeSequencer";
import { founderRepository } from "../repositories/founder.repository";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { NimLLMClient } from "../sandbox/nimLLMClient";
import {
  runIntakeExtractionAgent,
  extractionOutputToString,
} from "../agents/live/intakeExtractionAgent";
import { supabaseAdmin } from "../lib/supabaseAdmin";

export interface OrchestratorRouterOptions {
  verifyJwt?: JwtVerifier;
  enqueueStep?: (step: DagStep, data: JobData) => Promise<{ enqueued: boolean; reason?: string }>;
  stripe?: StripeClient;
}

export function createOrchestratorRouter(opts: OrchestratorRouterOptions = {}): Router {
  const router = Router();
  const authMiddleware = makeAuthMiddleware(opts.verifyJwt);
  const doEnqueueStep = opts.enqueueStep ?? enqueueStep;
  const doStripe = opts.stripe ?? getStripe();

  // GET /stripe/price
  // Returns unit_amount + currency for the configured pro price so the frontend
  // can display the real price without hardcoding it. Public — price info is not secret.
  router.get("/stripe/price", async (_req: Request, res: Response) => {
    try {
      const priceId = process.env.STRIPE_PRO_PRICE_ID;
      if (!priceId) return res.status(500).json({ error: "STRIPE_PRO_PRICE_ID not configured" });
      const price = await doStripe.prices.retrieve(priceId);
      return res.json({ unitAmount: price.unit_amount, currency: price.currency });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // Apply auth to all protected route prefixes. /auth/session stays public.
  router.use("/founders", authMiddleware);
  router.use("/hypotheses", authMiddleware);
  router.use("/runs", authMiddleware);

  // GET /auth/session
  // Verifies a Supabase JWT and returns the matching founder id.
  // Called by the web app's auth callback route. Step 8 absorbs this
  // verification into shared middleware once all protected routes are wired.
  router.get("/auth/session", async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!jwt) return res.status(401).json({ error: "missing token" });

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwt);
    if (error || !user) return res.status(401).json({ error: "invalid token" });

    let founder = await prisma.founder.findUnique({
      where: { authUserId: user.id },
      select: { id: true },
    });

    let isNew = false;
    if (!founder) {
      founder = await prisma.founder.create({
        data: {
          authUserId: user.id,
          expertise: [],
          industries: [],
          distributionAssets: [],
          audienceAssets: [],
          constraints: [],
        },
        select: { id: true },
      });
      isNew = true;
    }

    return res.json({ founderId: founder.id, authUserId: user.id, isNew });
  });

  // POST /hypotheses/:id/orchestrate
  // Body (optional): { runId?, vertical?, marketId?, problemId? }
  // founderId is ignored from the body — req.founderId (from auth middleware) is used.
  router.post("/hypotheses/:id/orchestrate", async (req: Request, res: Response) => {
    try {
      const hypothesisId = String(req.params.id);
      const body = (req.body ?? {}) as {
        runId?: string;
        vertical?: string;
        marketId?: string;
        problemId?: string;
      };

      const { runId, isNewRun } = await resolveRunId(hypothesisId, body, req.founderId);
      const jobData = {
        runId,
        hypothesisId,
        marketId: body.marketId,
        problemId: body.problemId,
      };

      if (isNewRun) {
        // Fresh run: enqueue the first stage.
        await doEnqueueStep("discovery", jobData);
        return res.status(202).json({ runId, hypothesisId, resumedFrom: "discovery", isNewRun });
      }

      // Existing run: resume from the earliest non-succeeded step.
      const rows = await checkpoint.listForRun(runId);
      const anyRunning = rows.some((r) => r.status === "running");
      if (anyRunning) {
        // A worker is holding a step — don't double-enqueue.
        return res.status(200).json({
          runId,
          hypothesisId,
          resumedFrom: null,
          reason: "already running — returning current status",
          steps: rows,
        });
      }
      const { resumedFrom } = await resumeFromCheckpoint(jobData);
      return res.status(202).json({ runId, hypothesisId, resumedFrom, isNewRun: false });
    } catch (err) {
      if (err instanceof ForbiddenError) return res.status(403).json({ error: "forbidden" });
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /hypotheses/:id/status
  // Returns per-step status with full DAG topology.
  //
  // Response shape:
  //   {
  //     run: { runId, hypothesisId, vertical, startedAt, overall },
  //     stages: Array<
  //       | { type: "step",  step, label, status, attemptCount, startedAt, completedAt, lastError }
  //       | { type: "fork",  branches: StepInfo[] }   // confidence_mode2 + founder_fit siblings
  //     >
  //   }
  // Compression (the join step) appears as the last "step" stage after the fork.
  router.get("/hypotheses/:id/status", async (req: Request, res: Response) => {
    try {
      const hypothesisId = String(req.params.id);
      const anyRow = await prisma.dagRunState.findFirst({ where: { hypothesisId } });
      if (!anyRow) {
        return res.status(404).json({ error: "no run found for this hypothesis" });
      }
      const runId = anyRow.runId;
      const [rows, pipelineRun] = await Promise.all([
        checkpoint.listForRun(runId),
        prisma.pipelineRun.findUnique({ where: { runId } }),
      ]);
      if (!pipelineRun || pipelineRun.founderId !== req.founderId) {
        return res.status(403).json({ error: "forbidden" });
      }
      const byStep = new Map(rows.map((r) => [r.step, r]));
      const perStep = DAG_STEPS.map((step) => ({
        step,
        label: STEP_LABELS[step],
        status: byStep.get(step)?.status ?? "not_started",
        attemptCount: byStep.get(step)?.attemptCount ?? 0,
        lastError: byStep.get(step)?.lastError ?? null,
        startedAt: byStep.get(step)?.startedAt ?? null,
        completedAt: byStep.get(step)?.completedAt ?? null,
      }));
      const overall = deriveOverallStatus(perStep);
      return res.status(200).json({
        run: {
          runId,
          hypothesisId,
          vertical: pipelineRun?.vertical ?? null,
          startedAt: pipelineRun?.startedAt ?? null,
          overall,
        },
        stages: buildStages(perStep),
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /runs/:runId/status
  // Same response shape as GET /hypotheses/:id/status but keyed by the
  // pipeline_run's UUID, which is what the dashboard and RunCard already
  // have. The hypotheses/:id/status route remains for callers that track
  // by hypothesis ID (orchestrate endpoint, scripts).
  router.get("/runs/:runId/status", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const pipelineRun = await prisma.pipelineRun.findUnique({ where: { runId } });
      if (!pipelineRun) return res.status(404).json({ error: "run not found" });
      if (pipelineRun.founderId !== req.founderId) {
        return res.status(403).json({ error: "forbidden" });
      }
      const rows = await checkpoint.listForRun(runId);
      const hypothesisId = rows.find((r) => r.hypothesisId != null)?.hypothesisId ?? null;
      const byStep = new Map(rows.map((r) => [r.step, r]));
      const perStep = DAG_STEPS.map((step) => ({
        step,
        label: STEP_LABELS[step],
        status: byStep.get(step)?.status ?? "not_started",
        attemptCount: byStep.get(step)?.attemptCount ?? 0,
        lastError: byStep.get(step)?.lastError ?? null,
        startedAt: byStep.get(step)?.startedAt ?? null,
        completedAt: byStep.get(step)?.completedAt ?? null,
      }));
      const overall = deriveOverallStatus(perStep);
      return res.status(200).json({
        run: {
          runId,
          hypothesisId,
          vertical: pipelineRun.vertical,
          startedAt: pipelineRun.startedAt,
          overall,
        },
        stages: buildStages(perStep),
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /runs/:runId/result
  // Returns the full promoted Opportunity for a completed run.
  //
  // Response: { runId, overall, vertical, opportunity: OpportunityDetail | null }
  // opportunity is null in two cases:
  //   (a) overall !== "completed" — caller should redirect to the status view
  //   (b) overall === "completed" but no candidate was promoted — analysis concluded
  //       without a viable winner (Compression found nothing above the bar)
  router.get("/runs/:runId/result", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const pipelineRun = await prisma.pipelineRun.findUnique({ where: { runId } });
      if (!pipelineRun) return res.status(404).json({ error: "run not found" });
      if (pipelineRun.founderId !== req.founderId) {
        return res.status(403).json({ error: "forbidden" });
      }

      const rows = await checkpoint.listForRun(runId);
      const perStep = DAG_STEPS.map((step) => ({
        step,
        status: rows.find((r) => r.step === step)?.status ?? "not_started",
      }));
      const overall = deriveOverallStatus(perStep);

      // Only query for opportunity when completed — avoids a DB round-trip
      // for in-progress and failed runs where no row will exist yet.
      let opportunity: {
        ventureScore: number;
        confidenceScore: number;
        founderFitScore: number;
        founderFitRationale: string | null;
        rationaleBullets: string[];
        riskSummary: string[];
      } | null = null;

      if (overall === "completed") {
        const candidate = await prisma.opportunityCandidate.findFirst({
          where: { runId, promotedOpportunity: { isNot: null } },
          include: { promotedOpportunity: true },
        });
        if (candidate?.promotedOpportunity) {
          const opp = candidate.promotedOpportunity;
          opportunity = {
            ventureScore: opp.ventureScore,
            confidenceScore: opp.confidenceScore,
            founderFitScore: opp.founderFitScore,
            founderFitRationale: opp.founderFitRationale ?? null,
            rationaleBullets: opp.rationaleBullets ?? [],
            riskSummary: opp.riskSummary ?? [],
          };
        }
      }

      return res.status(200).json({ runId, overall, vertical: pipelineRun.vertical, opportunity });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /hypotheses/:id/steps/:step/retry
  router.post("/hypotheses/:id/steps/:step/retry", async (req: Request, res: Response) => {
    try {
      const hypothesisId = String(req.params.id);
      const step = String(req.params.step) as DagStep;
      if (!DAG_STEPS.includes(step)) {
        return res.status(400).json({ error: `unknown step '${step}'` });
      }
      const anyRow = await prisma.dagRunState.findFirst({ where: { hypothesisId } });
      if (!anyRow) return res.status(404).json({ error: "no run found for this hypothesis" });
      const runId = anyRow.runId;
      const run = await prisma.pipelineRun.findUnique({ where: { runId } });
      if (!run || run.founderId !== req.founderId) {
        return res.status(403).json({ error: "forbidden" });
      }
      await checkpoint.resetForRetry(runId, step);
      await doEnqueueStep(step, { runId, hypothesisId });
      return res.status(202).json({ runId, hypothesisId, step, retried: true });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /runs/:runId/retry
  // Free retry for a run in the 'failed' state — no Stripe interaction.
  // Finds all failed_permanent steps, resets each to pending, and re-enqueues
  // via the same enqueueStep used for fresh runs. Returns 400 if the run is
  // not failed, 403 if the caller does not own it.
  router.post("/runs/:runId/retry", async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);
      const pipelineRun = await prisma.pipelineRun.findUnique({ where: { runId } });
      if (!pipelineRun) return res.status(404).json({ error: "run not found" });
      if (pipelineRun.founderId !== req.founderId) {
        return res.status(403).json({ error: "forbidden" });
      }

      if (pipelineRun.status !== "failed") {
        return res.status(400).json({
          error: `cannot retry: run status is '${pipelineRun.status}', only 'failed' runs can be retried`,
        });
      }

      const rows = await checkpoint.listForRun(runId);
      const failedRows = rows.filter((r) => r.status === "failed_permanent");
      const hypothesisId = rows.find((r) => r.hypothesisId != null)?.hypothesisId ?? undefined;

      const retried: string[] = [];
      for (const row of failedRows) {
        await checkpoint.resetForRetry(runId, row.step as DagStep);
        await doEnqueueStep(row.step as DagStep, { runId, hypothesisId });
        retried.push(row.step);
      }

      return res.status(202).json({ runId, retried });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /founders/:id/runs
  // Returns all pipeline_runs for a founder, newest-first.
  // Each entry includes:
  //   - overall status derived from dag_run_state (same logic as /status)
  //   - the promoted Opportunity's headline figures if the run completed
  //     (opportunity: null if not yet promoted)
  //
  // "headline" is rationaleBullets[0] — the Opportunity model has no
  // dedicated title field; the first rationale bullet is the closest proxy.
  router.get("/founders/:id/runs", async (req: Request, res: Response) => {
    try {
      const founderId = String(req.params.id);
      if (req.founderId !== founderId) {
        return res.status(403).json({ error: "forbidden" });
      }

      const runs = await prisma.pipelineRun.findMany({
        where: { founderId },
        orderBy: { startedAt: "desc" },
      });

      if (runs.length === 0) return res.status(200).json([]);

      const runIds = runs.map((r) => r.runId);

      const [allCheckpoints, promotedCandidates] = await Promise.all([
        prisma.dagRunState.findMany({ where: { runId: { in: runIds } } }),
        prisma.opportunityCandidate.findMany({
          where: { runId: { in: runIds }, promotedOpportunity: { isNot: null } },
          include: { promotedOpportunity: true },
        }),
      ]);

      // Index by runId for O(1) lookups
      const checkpointsByRun = new Map<string, typeof allCheckpoints>();
      for (const cp of allCheckpoints) {
        if (!checkpointsByRun.has(cp.runId)) checkpointsByRun.set(cp.runId, []);
        checkpointsByRun.get(cp.runId)!.push(cp);
      }
      const opportunityByRun = new Map<string, NonNullable<(typeof promotedCandidates)[0]["promotedOpportunity"]>>();
      for (const cand of promotedCandidates) {
        if (cand.promotedOpportunity) opportunityByRun.set(cand.runId, cand.promotedOpportunity);
      }

      const result = runs.map((run) => {
        const cps = checkpointsByRun.get(run.runId) ?? [];
        const perStep = DAG_STEPS.map((step) => {
          const cp = cps.find((r) => r.step === step);
          return { step, status: cp?.status ?? "not_started" };
        });
        const overall = deriveOverallStatus(perStep);
        const opp = opportunityByRun.get(run.runId) ?? null;
        return {
          runId: run.runId,
          vertical: run.vertical,
          createdAt: run.startedAt,
          overall,
          opportunity: opp
            ? {
                ventureScore: opp.ventureScore,
                confidenceScore: opp.confidenceScore,
                founderFitScore: opp.founderFitScore,
                headline: opp.rationaleBullets[0] ?? null,
              }
            : null,
        };
      });

      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /founders/:id/checkout
  // Creates a Stripe Checkout Session for a one-time payment.
  // Body: { vertical: string }
  // Returns: { url: string } — the frontend redirects to this URL.
  router.post("/founders/:id/checkout", async (req: Request, res: Response) => {
    try {
      const founderId = String(req.params.id);
      if (req.founderId !== founderId) {
        return res.status(403).json({ error: "forbidden" });
      }

      const { vertical } = (req.body ?? {}) as { vertical?: string };
      if (!vertical) return res.status(400).json({ error: "vertical is required" });
      if (!(ALLOWED_VERTICALS as readonly string[]).includes(vertical)) {
        return res.status(400).json({
          error: `unknown vertical '${vertical}' — must be one of: ${ALLOWED_VERTICALS.join(", ")}`,
        });
      }

      const priceId = process.env.STRIPE_PRO_PRICE_ID;
      if (!priceId) return res.status(500).json({ error: "STRIPE_PRO_PRICE_ID not configured" });

      const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3001";

      const session = await doStripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { founderId, vertical },
        success_url: `${webOrigin}/vertical-request/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${webOrigin}/vertical-request?canceled=true`,
      });

      return res.json({ url: session.url });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /founders/:id/checkout-status?session_id=...
  // Fallback for the success page: polls whether payment landed and whether the
  // webhook has already created a pipeline_run for this session.
  // Returns: { paid: boolean, runId: string | null }
  router.get("/founders/:id/checkout-status", async (req: Request, res: Response) => {
    try {
      const founderId = String(req.params.id);
      if (req.founderId !== founderId) {
        return res.status(403).json({ error: "forbidden" });
      }

      const sessionId = String(req.query.session_id ?? "");
      if (!sessionId) return res.status(400).json({ error: "session_id is required" });

      const [session, run] = await Promise.all([
        doStripe.checkout.sessions.retrieve(sessionId),
        prisma.pipelineRun.findUnique({
          where: { stripeSessionId: sessionId },
          select: { runId: true, founderId: true },
        }),
      ]);

      const paid = session.payment_status === "paid";
      // Guard: only surface the runId if it belongs to the authenticated founder.
      const runId = run?.founderId === founderId ? run.runId : null;

      return res.json({ paid, runId: runId ?? null });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /founders/:id/intake/turn
  //
  // Orchestrates one full interview turn:
  //   No rawAnswer  → advance state to next question, return it (first call pattern).
  //   With rawAnswer → extract structured value via LLM, save evidence, run
  //                    contradiction detection, advance to next question (or signal complete).
  //
  // Request body:
  //   { rawAnswer?: string; fieldTarget?: MustFillField }
  //   rawAnswer requires fieldTarget — returns 400 if missing or invalid.
  //
  // Response:
  //   {
  //     intakeComplete: boolean,
  //     currentQuestion: { text: string, fieldTarget: MustFillField, isFollowUp: boolean } | null,
  //     contradictionFlag: ContradictionFlag | null,
  //     questionCount: number
  //   }
  //
  // currentQuestion is null when intakeComplete === true (coverage met or cap hit).
  // contradictionFlag is non-null when the incoming rawAnswer contradicts an
  // earlier answer per CONTRADICTION_RULES (solo↔team, bootstrapped↔raised, etc.).
  // The flag is stored on the state; the caller (chat UI) decides how to surface it.
  router.post("/founders/:id/intake/turn", async (req: Request, res: Response) => {
    try {
      const founderId = String(req.params.id);
      if (req.founderId !== founderId) {
        return res.status(403).json({ error: "forbidden" });
      }
      const body = (req.body ?? {}) as {
        rawAnswer?: string;
        fieldTarget?: string;
      };

      const founder = await founderRepository.findById(founderId);
      if (!founder) return res.status(404).json({ error: "founder not found" });

      // Parse JSONB intake state, defaulting to empty if session not yet started.
      let state: FounderIntakeState = founder.intakeState
        ? (founder.intakeState as unknown as FounderIntakeState)
        : emptyIntakeState();

      const profile: FounderProfile = {
        expertise: (founder.expertise ?? []) as string[],
        distributionAssets: (founder.distributionAssets ?? []) as string[],
        capitalAvailability: founder.capitalAvailability as string | null,
      };

      let contradictionFlag: ContradictionFlag | null = null;

      // ── Answer processing (only when rawAnswer is present) ─────────────
      if (body.rawAnswer !== undefined) {
        const VALID_FIELDS: MustFillField[] = ["expertise", "distributionAssets", "capitalAvailability"];
        const fieldTarget = body.fieldTarget as MustFillField | undefined;
        if (!fieldTarget || !VALID_FIELDS.includes(fieldTarget)) {
          return res.status(400).json({
            error: "fieldTarget is required and must be 'expertise', 'distributionAssets', or 'capitalAvailability' when rawAnswer is provided",
          });
        }

        // Derive the question text that was shown to the founder.
        // For expertise: the last question asked was the follow-up if
        // followUpAsked is already true on the state (set at ask-time).
        const wasFollowUp = fieldTarget === "expertise" && state.fields.expertise.followUpAsked;
        const questionText = wasFollowUp
          ? QUESTIONS.expertise.followUp
          : QUESTIONS[fieldTarget].opener;

        // Build LLM client for extraction.
        const llm = await buildIntakeLLMClient();

        // Run the extraction agent — one LLM call, one structured value.
        const extraction = await runIntakeExtractionAgent(founderId, {
          field: fieldTarget,
          question: questionText,
          rawAnswer: body.rawAnswer,
        }, llm);

        const extractedValue = extractionOutputToString(extraction.output);

        // Record depth on state (word count) — observability only, no gate.
        state = recordFieldAnswer(state, fieldTarget, body.rawAnswer);

        // Contradiction check against current profile BEFORE the new evidence
        // is committed — we compare the new raw answer against existing values.
        const flag = detectContradiction(profile, fieldTarget, body.rawAnswer);
        if (flag) {
          contradictionFlag = flag;
          state = addContradictionFlag(state, flag);
        }

        // Persist: evidence INSERT + profile re-derive + founder UPDATE.
        // saveIntakeTurn is the single write path for intake evidence.
        await founderRepository.saveIntakeTurn(founderId, state, {
          targetField: fieldTarget,
          questionAsked: questionText,
          rawAnswer: body.rawAnswer,
          extractedValue,
        });

        // Reload the denormalized profile so the sequencer sees the new
        // evidence when deciding whether an expertise follow-up is needed.
        const refreshed = await founderRepository.findById(founderId);
        if (refreshed) {
          profile.expertise = (refreshed.expertise ?? []) as string[];
          profile.distributionAssets = (refreshed.distributionAssets ?? []) as string[];
          profile.capitalAvailability = refreshed.capitalAvailability as string | null;
        }
      }

      // ── Next question advance ──────────────────────────────────────────
      const seq = nextQuestion(state, profile);

      let finalState: FounderIntakeState;
      if (seq.done) {
        finalState = seq.terminatedByCap
          ? forceCompleteByCapTermination(state)
          : markIntakeComplete(state);
      } else if (seq.isFollowUp) {
        finalState = recordFollowUpAsked(state, seq.fieldTarget);
      } else {
        finalState = recordFieldAsked(state, seq.fieldTarget);
      }

      // Persist the state advance (next question recorded as asked, or terminal).
      await prisma.founder.update({
        where: { id: founderId },
        data: { intakeState: finalState as object },
      });

      return res.status(200).json({
        intakeComplete: seq.done,
        currentQuestion: seq.done
          ? null
          : { text: seq.nextQuestion, fieldTarget: seq.fieldTarget, isFollowUp: seq.isFollowUp },
        contradictionFlag,
        questionCount: finalState.questionCount,
      });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

// buildIntakeLLMClient: looks up model routing config for the intake
// extraction agent. Falls back to FounderFit's config if IntakeExtraction
// has no dedicated row — both tasks require mid-tier judgment over short
// structured inputs, so the same model tier is appropriate.
async function buildIntakeLLMClient() {
  const config =
    (await modelRoutingConfigRepository.latestForAgent("IntakeExtraction")) ??
    (await modelRoutingConfigRepository.latestForAgent("FounderFit"));
  if (!config) {
    throw new Error(
      "no model_routing_config found for IntakeExtraction or FounderFit — add a seed row"
    );
  }
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY not set");
  return new NimLLMClient(key, config.nimModelId);
}

// buildStages: converts the flat per-step array into a topology-aware stages
// array the UI can render without re-deriving DAG structure.
//
// Shape:
//   Linear steps (discovery → scoring) → each is { type: "step", ... }
//   Fork                               → { type: "fork", branches: [mode2, founder_fit] }
//   Join/terminal (compression)        → { type: "step", ... }
type StepInfo = {
  step: DagStep;
  label: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};
export type Stage =
  | ({ type: "step" } & StepInfo)
  | { type: "fork"; branches: StepInfo[] };

export function buildStages(perStep: StepInfo[]): Stage[] {
  const byStep = new Map(perStep.map((s) => [s.step, s]));
  const stages: Stage[] = [];

  for (const step of LINEAR_ORDER) {
    stages.push({ type: "step", ...byStep.get(step)! });
  }

  stages.push({ type: "fork", branches: FORK_CHILDREN.map((step) => byStep.get(step)!) });

  stages.push({ type: "step", ...byStep.get(JOIN_STEP)! });

  return stages;
}

// deriveOverallStatus: single-pass status derivation shared by the status
// endpoint and the founder runs list. Exported for tests.
//
// "queued"     — run exists in DB but no DAG step has started yet
// "in_progress"— at least one step is running or pending
// "failed"     — at least one step is permanently failed
// "completed"  — the terminal join step (compression) has succeeded
export function deriveOverallStatus(perStep: { step: DagStep; status: string }[]): string {
  const statuses = new Set(perStep.map((p) => p.status));
  if (statuses.has("failed_permanent")) return "failed";
  if (statuses.has("running") || statuses.has("pending")) return "in_progress";
  const join = perStep.find((p) => p.step === JOIN_STEP);
  if (join?.status === "succeeded") return "completed";
  if (perStep.every((p) => p.status === "not_started")) return "queued";
  return "in_progress";
}

class ForbiddenError extends Error {
  constructor() { super("forbidden"); this.name = "ForbiddenError"; }
}

async function resolveRunId(
  hypothesisId: string,
  body: { runId?: string; vertical?: string },
  authenticatedFounderId: string
): Promise<{ runId: string; isNewRun: boolean }> {
  if (body.runId) {
    const run = await prisma.pipelineRun.findUnique({ where: { runId: body.runId } });
    if (!run || run.founderId !== authenticatedFounderId) throw new ForbiddenError();
    return { runId: body.runId, isNewRun: false };
  }
  const existing = await prisma.dagRunState.findFirst({ where: { hypothesisId } });
  if (existing) {
    const run = await prisma.pipelineRun.findUnique({ where: { runId: existing.runId } });
    if (!run || run.founderId !== authenticatedFounderId) throw new ForbiddenError();
    return { runId: existing.runId, isNewRun: false };
  }
  if (!body.vertical) {
    throw new Error(
      "cannot start a new run without vertical (no existing dag_run_state row for this hypothesis)"
    );
  }
  const run = await prisma.pipelineRun.create({
    data: { founderId: authenticatedFounderId, vertical: body.vertical },
  });
  return { runId: run.runId, isNewRun: true };
}
