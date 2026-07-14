import type { Request, Response } from "express";
import { prisma } from "../db/client";
import type { StripeClient, StripeWebhookEvent } from "./types";
import { enqueueStep as defaultEnqueueStep } from "../orchestrator/sequencing";
import type { DagStep } from "../orchestrator/steps";
import type { JobData } from "../orchestrator/handlers";

type EnqueueFn = (step: DagStep, data: JobData) => Promise<{ enqueued: boolean; reason?: string }>;

export function makeWebhookHandler(stripe: StripeClient, opts: { enqueueStep?: EnqueueFn } = {}) {
  const doEnqueue = opts.enqueueStep ?? defaultEnqueueStep;

  return async (req: Request, res: Response): Promise<void> => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET not configured" });
      return;
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) {
      res.status(400).json({ error: "missing stripe-signature header" });
      return;
    }

    let event: StripeWebhookEvent;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig as string | string[],
        secret
      );
    } catch (err) {
      console.error("[stripe-webhook] signature verification failed:", (err as Error).message);
      res.status(400).json({ error: "invalid signature" });
      return;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as {
        id: string;
        metadata?: Record<string, string | null> | null;
      };
      const founderId = session.metadata?.founderId;
      const vertical = session.metadata?.vertical ?? "shopify_subscriptions";
      const stripeSessionId = session.id;

      if (!founderId) {
        console.error("[stripe-webhook] missing founderId in session metadata", stripeSessionId);
        res.status(400).json({ error: "missing founderId in session metadata" });
        return;
      }

      try {
        // Idempotency: stripeSessionId is UNIQUE — a second delivery for the
        // same session hits the findUnique guard and skips creation + enqueue.
        const existing = await prisma.pipelineRun.findUnique({
          where: { stripeSessionId },
          select: { runId: true },
        });

        if (!existing) {
          const run = await prisma.pipelineRun.create({
            data: { founderId, vertical, stripeSessionId },
          });
          // Kick off the DAG. upsertPending (inside enqueueStep) writes the
          // dag_run_state row before the BullMQ job is added, preventing the
          // race where a worker reads the checkpoint before the row exists.
          await doEnqueue("discovery", { runId: run.runId });
        }
      } catch (err) {
        console.error("[stripe-webhook] failed to create pipeline_run:", (err as Error).message);
        res.status(500).json({ error: "internal error processing payment" });
        return;
      }
    }

    res.status(200).json({ received: true });
  };
}
