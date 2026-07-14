import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import type { StripeClient, StripeWebhookEvent } from "../types";
import type { DagStep } from "../../orchestrator/steps";
import type { JobData } from "../../orchestrator/handlers";

// ── Test tokens / auth-user IDs ───────────────────────────────────────────────
const AUTH_USER_A = "aaaaaaaa-1111-0000-0000-000000000001";
const AUTH_USER_B = "bbbbbbbb-2222-0000-0000-000000000002";
const TOKEN_A     = "stripe-test-token-a";
const TOKEN_B     = "stripe-test-token-b";

const fakeVerifyJwt = async (jwt: string): Promise<string | null> => {
  if (jwt === TOKEN_A) return AUTH_USER_A;
  if (jwt === TOKEN_B) return AUTH_USER_B;
  return null;
};

// ── Fake Stripe values ────────────────────────────────────────────────────────
const FAKE_SESSION_URL = "https://checkout.stripe.com/pay/cs_test_fake";
const FAKE_SESSION_ID  = "cs_test_fake_session_id";
const VALID_SIG        = "valid_stripe_sig";

// constructEvent mock: passes if header === VALID_SIG, throws otherwise.
// Parses the raw payload as the event so tests control the event shape.
function makeFakeStripe(overrides: {
  paymentStatus?: string;
  sessionId?: string;
  priceUnitAmount?: number;
  priceCurrency?: string;
} = {}): StripeClient {
  return {
    checkout: {
      sessions: {
        create: async () => ({
          id: overrides.sessionId ?? FAKE_SESSION_ID,
          url: FAKE_SESSION_URL,
        }),
        retrieve: async (id) => ({
          id,
          payment_status: overrides.paymentStatus ?? "paid",
        }),
      },
    },
    prices: {
      retrieve: async () => ({
        unit_amount: overrides.priceUnitAmount ?? 4900,
        currency: overrides.priceCurrency ?? "usd",
      }),
    },
    webhooks: {
      constructEvent: (payload, header): StripeWebhookEvent => {
        if (header !== VALID_SIG) {
          throw new Error("No signatures found matching the expected signature for payload.");
        }
        const raw = Buffer.isBuffer(payload) ? payload.toString() : String(payload);
        return JSON.parse(raw) as StripeWebhookEvent;
      },
    },
  };
}

function buildWebhookPayload(founderId: string, vertical: string, sessionId: string): string {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        payment_status: "paid",
        metadata: { founderId, vertical },
      },
    },
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function httpPost(
  port: number,
  path: string,
  body: string | object,
  opts: { token?: string; extraHeaders?: Record<string, string> } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type":   "application/json",
      "content-length": Buffer.byteLength(rawBody).toString(),
      ...opts.extraHeaders,
    };
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

async function httpGet(
  port: number,
  path: string,
  token?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http.request(
      {
        hostname: "127.0.0.1", port, path, method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
        });
      }
    ).on("error", reject).end();
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────
const createdFounderIds: string[] = [];
const createdRunIds:     string[] = [];

async function makeFounder(authUserId: string): Promise<string> {
  const f = await prisma.founder.create({
    data: { authUserId, expertise: [], industries: [], constraints: [] },
  });
  createdFounderIds.push(f.id);
  return f.id;
}

async function cleanup() {
  if (createdRunIds.length > 0) {
    await prisma.dagRunState.deleteMany({ where: { runId: { in: createdRunIds } } });
    await prisma.pipelineRun.deleteMany({ where: { runId: { in: createdRunIds } } });
  }
  if (createdFounderIds.length > 0) {
    await prisma.founder.deleteMany({ where: { id: { in: createdFounderIds } } });
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("Stripe payment endpoints", () => {
  let port: number;
  let server: http.Server;
  let founderA: string;
  let founderB: string;

  beforeAll(async () => {
    const app = createApp({
      verifyJwt: fakeVerifyJwt,
      enqueueStep: async () => ({ enqueued: true }),
      stripe: makeFakeStripe(),
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    port = (server.address() as { port: number }).port;
    founderA = await makeFounder(AUTH_USER_A);
    founderB = await makeFounder(AUTH_USER_B);
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    await prisma.$disconnect();
  });

  // ── POST /founders/:id/checkout ────────────────────────────────────────────

  describe("POST /founders/:id/checkout", () => {
    it("owner gets 200 with checkout URL", async () => {
      const res = await httpPost(
        port,
        `/founders/${founderA}/checkout`,
        { vertical: "shopify_subscriptions" },
        { token: TOKEN_A }
      );
      expect(res.status).toBe(200);
      expect((res.body as Record<string, unknown>).url).toBe(FAKE_SESSION_URL);
    });

    it("non-owner gets 403", async () => {
      const res = await httpPost(
        port,
        `/founders/${founderA}/checkout`,
        { vertical: "shopify_subscriptions" },
        { token: TOKEN_B }
      );
      expect(res.status).toBe(403);
    });

    it("missing vertical returns 400", async () => {
      const res = await httpPost(port, `/founders/${founderA}/checkout`, {}, { token: TOKEN_A });
      expect(res.status).toBe(400);
    });

    it("unrecognized vertical returns 400", async () => {
      const res = await httpPost(
        port,
        `/founders/${founderA}/checkout`,
        { vertical: "subscription_commerce" },
        { token: TOKEN_A }
      );
      expect(res.status).toBe(400);
      expect((res.body as Record<string, unknown>).error).toMatch(/unknown vertical/);
    });

    it("unauthenticated request returns 401", async () => {
      const res = await httpPost(port, `/founders/${founderA}/checkout`, { vertical: "shopify_subscriptions" });
      expect(res.status).toBe(401);
    });
  });

  // ── POST /webhooks/stripe ──────────────────────────────────────────────────

  describe("POST /webhooks/stripe", () => {
    const sessionForFounderA  = "cs_test_sig_ok_founder_a_01";
    const sessionForDuplicate = "cs_test_sig_dup_01";

    it("valid signature creates a pipeline_run for the founder in metadata", async () => {
      const payload = buildWebhookPayload(founderA, "shopify_subscriptions", sessionForFounderA);
      const res = await httpPost(port, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": VALID_SIG },
      });
      expect(res.status).toBe(200);

      const run = await prisma.pipelineRun.findUnique({
        where: { stripeSessionId: sessionForFounderA },
      });
      expect(run).not.toBeNull();
      expect(run?.founderId).toBe(founderA);
      expect(run?.vertical).toBe("shopify_subscriptions");
      if (run) createdRunIds.push(run.runId);
    });

    it("invalid signature returns 400 and does not create a run", async () => {
      const sessionId = "cs_test_bad_sig_01";
      const payload = buildWebhookPayload(founderA, "shopify_subscriptions", sessionId);
      const res = await httpPost(port, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": "bad_sig_value" },
      });
      expect(res.status).toBe(400);

      const run = await prisma.pipelineRun.findFirst({ where: { stripeSessionId: sessionId } });
      expect(run).toBeNull();
    });

    it("duplicate delivery for same session_id does not create a second run", async () => {
      const payload = buildWebhookPayload(founderA, "shopify_subscriptions", sessionForDuplicate);

      const res1 = await httpPost(port, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": VALID_SIG },
      });
      expect(res1.status).toBe(200);

      // Stripe retry
      const res2 = await httpPost(port, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": VALID_SIG },
      });
      expect(res2.status).toBe(200);

      const runs = await prisma.pipelineRun.findMany({
        where: { stripeSessionId: sessionForDuplicate },
      });
      expect(runs.length).toBe(1);
      createdRunIds.push(runs[0].runId);
    });
  });

  // ── GET /founders/:id/checkout-status ─────────────────────────────────────

  describe("GET /founders/:id/checkout-status", () => {
    const statusSessionId = "cs_test_status_01";
    let statusRunId: string;

    beforeAll(async () => {
      const run = await prisma.pipelineRun.create({
        data: {
          founderId: founderA,
          vertical: "shopify_subscriptions",
          stripeSessionId: statusSessionId,
        },
      });
      statusRunId = run.runId;
      createdRunIds.push(statusRunId);
    });

    it("owner gets paid:true and the runId when a run exists for the session", async () => {
      const res = await httpGet(
        port,
        `/founders/${founderA}/checkout-status?session_id=${statusSessionId}`,
        TOKEN_A
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.paid).toBe(true);
      expect(body.runId).toBe(statusRunId);
    });

    it("returns paid:true, runId:null when payment registered but webhook not yet processed", async () => {
      const pendingSession = "cs_test_not_processed_yet";
      const res = await httpGet(
        port,
        `/founders/${founderA}/checkout-status?session_id=${pendingSession}`,
        TOKEN_A
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.paid).toBe(true);   // fake stripe always returns "paid"
      expect(body.runId).toBeNull();  // no run in DB yet
    });

    it("non-owner gets 403", async () => {
      const res = await httpGet(
        port,
        `/founders/${founderA}/checkout-status?session_id=${statusSessionId}`,
        TOKEN_B
      );
      expect(res.status).toBe(403);
    });

    it("missing session_id returns 400", async () => {
      const res = await httpGet(port, `/founders/${founderA}/checkout-status`, TOKEN_A);
      expect(res.status).toBe(400);
    });

    it("unauthenticated request returns 401", async () => {
      const res = await httpGet(
        port,
        `/founders/${founderA}/checkout-status?session_id=${statusSessionId}`
      );
      expect(res.status).toBe(401);
    });
  });

  // ── GET /stripe/price ─────────────────────────────────────────────────────

  describe("GET /stripe/price", () => {
    it("returns unitAmount and currency from the configured price", async () => {
      const res = await httpGet(port, "/stripe/price");
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.unitAmount).toBe(4900);
      expect(body.currency).toBe("usd");
    });

    it("is public — no auth token required", async () => {
      const res = await httpGet(port, "/stripe/price");
      expect(res.status).toBe(200);
    });
  });

  // ── Webhook enqueue behavior ───────────────────────────────────────────────
  // Separate server so we can inject a vi.fn() spy and assert on call count.

  describe("POST /webhooks/stripe — discovery enqueue", () => {
    let spyPort: number;
    let spyServer: http.Server;
    const enqueueSpy = vi.fn(async (_step: DagStep, _data: JobData) => ({ enqueued: true }));

    beforeAll(async () => {
      const spyApp = createApp({
        verifyJwt: fakeVerifyJwt,
        enqueueStep: enqueueSpy,
        stripe: makeFakeStripe(),
      });
      spyServer = await new Promise<http.Server>((resolve) => {
        const s = spyApp.listen(0, "127.0.0.1", () => resolve(s));
      });
      spyPort = (spyServer.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise<void>((r) => spyServer.close(() => r()));
    });

    beforeEach(() => { enqueueSpy.mockClear(); });

    it("enqueues discovery once on first webhook delivery", async () => {
      const sessionId = "cs_test_enqueue_spy_01";
      const payload = buildWebhookPayload(founderA, "shopify_subscriptions", sessionId);
      const res = await httpPost(spyPort, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": VALID_SIG },
      });
      expect(res.status).toBe(200);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith(
        "discovery",
        expect.objectContaining({ runId: expect.any(String) })
      );

      const run = await prisma.pipelineRun.findUnique({ where: { stripeSessionId: sessionId } });
      if (run) createdRunIds.push(run.runId);
    });

    it("does not enqueue on duplicate webhook delivery for same session", async () => {
      const sessionId = "cs_test_enqueue_spy_dup_01";
      const payload = buildWebhookPayload(founderA, "shopify_subscriptions", sessionId);

      // First delivery — creates run and enqueues
      await httpPost(spyPort, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": VALID_SIG },
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);

      enqueueSpy.mockClear();

      // Duplicate delivery — idempotency guard skips creation and enqueue
      const res2 = await httpPost(spyPort, "/webhooks/stripe", payload, {
        extraHeaders: { "stripe-signature": VALID_SIG },
      });
      expect(res2.status).toBe(200);
      expect(enqueueSpy).not.toHaveBeenCalled();

      const run = await prisma.pipelineRun.findUnique({ where: { stripeSessionId: sessionId } });
      if (run) createdRunIds.push(run.runId);
    });
  });
});
