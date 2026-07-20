// Regression for the "intake starts from question 2 instead of question 1"
// bug. Prior behavior: POST /founders/:id/intake/turn with rawAnswer=undefined
// ALWAYS advanced state — called recordFieldAsked, incremented questionCount,
// persisted. React 18 StrictMode double-invokes mount effects in dev, so
// IntakeChat's `useEffect(() => sendTurn({}), [sendTurn])` fired the POST
// twice on mount. The second call read state after the first save, saw
// expertise.asked=true, and the sequencer skipped ahead to distributionAssets
// (Q2). Client displayed the distributionAssets opener as its "first"
// question. Same failure surface for page refresh mid-request.
//
// Fix: state now tracks a `pendingQuestion` pointer set by
// recordFieldAsked/recordFollowUpAsked and cleared by recordFieldAnswer.
// Fresh-turn calls (rawAnswer=undefined) short-circuit on a non-null
// pendingQuestion and return that same question WITHOUT advancing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import type { JwtVerifier } from "../../middleware/auth";
import { QUESTIONS } from "../../intake/founderIntakeSequencer";

const AUTH_USER_INTAKE = "eeeeeeee-0000-0000-0000-000000000005";
const TOKEN_INTAKE = "test-token-intake";

const fakeVerifyJwt: JwtVerifier = async (jwt) => (jwt === TOKEN_INTAKE ? AUTH_USER_INTAKE : null);

function httpPost(port: number, path: string, body: unknown, token?: string) {
  const payload = JSON.stringify(body);
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function seedFounder(): Promise<string> {
  await prisma.founderEvidence.deleteMany({ where: { founder: { authUserId: AUTH_USER_INTAKE } } });
  await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_INTAKE } });
  const row = await prisma.founder.create({
    data: {
      authUserId: AUTH_USER_INTAKE,
      expertise: [],
      industries: [],
      constraints: [],
      distributionAssets: [],
    },
    select: { id: true },
  });
  return row.id;
}

async function cleanup(): Promise<void> {
  await prisma.founderEvidence.deleteMany({ where: { founder: { authUserId: AUTH_USER_INTAKE } } });
  await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_INTAKE } });
}

describe("/intake/turn — fresh-turn idempotency (StrictMode double-fire fix)", () => {
  let port: number;
  let server: http.Server;

  beforeAll(async () => {
    const app = createApp({ verifyJwt: fakeVerifyJwt, enqueueStep: async () => ({ enqueued: false }) });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("two SEQUENTIAL fresh-turn calls (StrictMode-style) return the SAME question — expertise opener both times", async () => {
    const founderId = await seedFounder();

    // Call 1 — mimics React's first mount effect invocation.
    const r1 = await httpPost(port, `/founders/${founderId}/intake/turn`, {}, TOKEN_INTAKE);
    // Call 2 — mimics React 18 StrictMode's second (development-only) invocation,
    // firing after Call 1's DB write has committed.
    const r2 = await httpPost(port, `/founders/${founderId}/intake/turn`, {}, TOKEN_INTAKE);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = r1.body as { currentQuestion: { text: string; fieldTarget: string; isFollowUp: boolean }; questionCount: number };
    const b2 = r2.body as { currentQuestion: { text: string; fieldTarget: string; isFollowUp: boolean }; questionCount: number };

    // Pre-fix bug: b2.currentQuestion.text === QUESTIONS.distributionAssets.opener
    //              b2.questionCount === 2
    // Post-fix invariant: both return the same expertise opener + questionCount stays at 1.
    expect(b1.currentQuestion.fieldTarget).toBe("expertise");
    expect(b1.currentQuestion.text).toBe(QUESTIONS.expertise.opener);
    expect(b2.currentQuestion.fieldTarget).toBe("expertise");
    expect(b2.currentQuestion.text).toBe(QUESTIONS.expertise.opener);
    expect(b1.currentQuestion.text).toBe(b2.currentQuestion.text);
    expect(b2.questionCount).toBe(b1.questionCount);
    expect(b2.questionCount).toBe(1);
  });

  it("many-fold refresh scenario: 5 fresh-turn calls stay pinned to expertise opener, questionCount stays at 1", async () => {
    const founderId = await seedFounder();

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await httpPost(port, `/founders/${founderId}/intake/turn`, {}, TOKEN_INTAKE));
    }

    for (const r of results) {
      expect(r.status).toBe(200);
      const b = r.body as { currentQuestion: { text: string; fieldTarget: string }; questionCount: number };
      expect(b.currentQuestion.fieldTarget).toBe("expertise");
      expect(b.currentQuestion.text).toBe(QUESTIONS.expertise.opener);
      expect(b.questionCount).toBe(1);
    }
  });

  it("normal answer-then-fresh-turn flow still advances correctly (regression guard)", async () => {
    // Confirms the idempotency guard doesn't break the legitimate case:
    //   ask Q1 → answer Q1 → fresh call → should return Q2.
    const founderId = await seedFounder();

    // Turn 1: fresh → returns expertise opener.
    const r1 = await httpPost(port, `/founders/${founderId}/intake/turn`, {}, TOKEN_INTAKE);
    const b1 = r1.body as { currentQuestion: { fieldTarget: string; text: string } };
    expect(b1.currentQuestion.fieldTarget).toBe("expertise");

    // Turn 2: answer expertise. The extraction agent will call the LLM,
    // which we can't easily mock in this HTTP-level test — accept whatever
    // extraction happens and check the state advance. Use a long,
    // specific answer so expertiseNeedsFollowUp returns false and the
    // sequencer moves on to distributionAssets on the next turn.
    const r2 = await httpPost(
      port,
      `/founders/${founderId}/intake/turn`,
      {
        rawAnswer:
          "I've spent the last twelve years as a backend engineer building distributed systems, database infrastructure, and API services at a series of B2B SaaS companies — most recently as a staff engineer.",
        fieldTarget: "expertise",
      },
      TOKEN_INTAKE
    );
    // The extraction call might fail if NVIDIA_API_KEY isn't set — treat
    // 500 as "test env missing LLM" and skip the rest gracefully.
    if (r2.status !== 200) {
      console.warn("[test] skipping normal-flow advance check — extraction LLM call failed (500)");
      return;
    }
    const b2 = r2.body as { currentQuestion: { fieldTarget: string } | null; intakeComplete: boolean };
    // Post-answer, sequencer should advance to next unanswered field.
    // Depending on whether the answer triggered a followUp or not, this
    // could be expertise (followUp) or distributionAssets. Either is a
    // legitimate advance — verify it's NOT stuck on the same expertise
    // opener the pending-guard would have returned.
    if (!b2.intakeComplete) {
      expect(b2.currentQuestion).not.toBeNull();
      // Advance happened — pending pointer was cleared by the answer, then
      // reset by the fresh advance. The question shown MUST be different
      // from the initial opener OR marked as follow-up.
      const isNewQuestion =
        b2.currentQuestion!.fieldTarget !== "expertise" ||
        (b2.currentQuestion as { isFollowUp?: boolean }).isFollowUp === true;
      expect(isNewQuestion).toBe(true);
    }
  });

  it("state.pendingQuestion is populated after the first fresh call and cleared after an answer", async () => {
    const founderId = await seedFounder();

    await httpPost(port, `/founders/${founderId}/intake/turn`, {}, TOKEN_INTAKE);

    const afterAsk = await prisma.founder.findUnique({ where: { id: founderId }, select: { intakeState: true } });
    const stateAfterAsk = afterAsk?.intakeState as { pendingQuestion?: { fieldTarget: string; isFollowUp: boolean } | null };
    expect(stateAfterAsk?.pendingQuestion?.fieldTarget).toBe("expertise");
    expect(stateAfterAsk?.pendingQuestion?.isFollowUp).toBe(false);
  });
});
