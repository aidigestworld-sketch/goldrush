// HTTP server for the Opportunity Engine API. Currently exposes the
// Phase 6 Orchestrator router only.
//
// The API and the worker pool run in the same process for MVP simplicity
// — no need for a separate worker service until we need to scale
// horizontally. `startWorkers()` boots all 12 workers on server start;
// each keeps a long-lived Redis connection.
import cors from "cors";
import express from "express";
import type { Express } from "express";
import { createOrchestratorRouter, type OrchestratorRouterOptions } from "../orchestrator/api";
import { startWorkers, stopWorkers } from "../orchestrator/worker";
import { makeWebhookHandler } from "../stripe/webhook";
import { getStripe } from "../stripe/client";

export function createApp(opts: OrchestratorRouterOptions = {}): Express {
  const app = express();

  // Allow the web app's origin. CORS_ORIGIN can be a comma-separated list for
  // multi-origin dev setups; falls back to localhost:3001 (Next.js dev port).
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3001")
    .split(",")
    .map((s) => s.trim());

  app.use(
    cors({
      origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "stripe-signature"],
    })
  );

  // Stripe webhook must receive the raw body for signature verification.
  // Registered BEFORE express.json() so the global parser does not consume it.
  // This route is intentionally unauthenticated — Stripe verifies its own
  // signature; JWT auth would break it.
  const stripeClient = opts.stripe ?? getStripe();
  app.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    makeWebhookHandler(stripeClient, { enqueueStep: opts.enqueueStep })
  );

  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

  app.use("/", createOrchestratorRouter(opts));

  return app;
}

export interface StartedServer {
  stop: () => Promise<void>;
  port: number;
}

export async function startServer(port = Number(process.env.PORT ?? 3000)): Promise<StartedServer> {
  const app = createApp();
  startWorkers();
  return await new Promise((resolve) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[api] listening on port ${actualPort}`);
      resolve({
        port: actualPort,
        stop: async () => {
          await new Promise<void>((r) => server.close(() => r()));
          await stopWorkers();
        },
      });
    });
  });
}
