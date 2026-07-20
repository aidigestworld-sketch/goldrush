// Regression for the /auth/session founder-provisioning race.
//
// Prior behavior: findUnique-then-create check-then-act. Under concurrent
// calls for the same new auth_user_id (e.g. auth callback fetches
// /auth/session while dashboard page.tsx server component ALSO fetches
// /auth/session on the redirect target), both findUnique returned null,
// both create() fired, one hit Prisma P2002 on the authUserId unique
// index, and the losing client got a 500. The user saw this as
// "sometimes 401 / red banner on new logins" via the downstream request
// for a founder row that hadn't committed yet.
//
// Fix: Prisma upsert on authUserId (atomic at the unique-index level) +
// try/catch fallback on any residual P2002 that leaks. Both concurrent
// calls now settle on the same founder row.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { prisma } from "../../db/client";
import { createApp } from "../../api/server";
import type { JwtVerifier } from "../../middleware/auth";

const AUTH_USER_RACE = "dddddddd-0000-0000-0000-000000000004";
const TOKEN_RACE = "test-token-race";

const fakeVerifyJwt: JwtVerifier = async (jwt) => (jwt === TOKEN_RACE ? AUTH_USER_RACE : null);

function httpGet(port: number, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "GET",
          headers: token ? { authorization: `Bearer ${token}` } : {},
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
      )
      .on("error", reject)
      .end();
  });
}

async function cleanup(): Promise<void> {
  await prisma.founder.deleteMany({ where: { authUserId: AUTH_USER_RACE } });
}

describe("/auth/session — concurrent-provisioning race", () => {
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

  it("two concurrent calls for the same new authUserId → both succeed, exactly one founder row exists", async () => {
    // The concurrency scenario: auth callback + target-page server component
    // both hit /auth/session before either commits its founder create.
    const [res1, res2] = await Promise.all([
      httpGet(port, "/auth/session", TOKEN_RACE),
      httpGet(port, "/auth/session", TOKEN_RACE),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body1 = res1.body as { founderId: string; authUserId: string; isNew: boolean };
    const body2 = res2.body as { founderId: string; authUserId: string; isNew: boolean };

    // Both return the SAME founderId — critical: downstream code assumes
    // a stable id per authUser.
    expect(body1.founderId).toBe(body2.founderId);
    expect(body1.authUserId).toBe(AUTH_USER_RACE);
    expect(body2.authUserId).toBe(AUTH_USER_RACE);

    // Exactly one row was actually inserted.
    const count = await prisma.founder.count({ where: { authUserId: AUTH_USER_RACE } });
    expect(count).toBe(1);
  });

  it("high-fanout concurrency: 8 parallel calls → 8 successes, 1 row", async () => {
    // Belt-and-braces: exercise the upsert's atomicity under wider fanout.
    const promises = Array.from({ length: 8 }, () => httpGet(port, "/auth/session", TOKEN_RACE));
    const results = await Promise.all(promises);

    for (const r of results) {
      expect(r.status).toBe(200);
    }
    const founderIds = results.map((r) => (r.body as { founderId: string }).founderId);
    // All identical.
    expect(new Set(founderIds).size).toBe(1);
    const count = await prisma.founder.count({ where: { authUserId: AUTH_USER_RACE } });
    expect(count).toBe(1);
  });

  it("second call after founder exists → returns isNew=false, same id", async () => {
    // Sequential (not racing) call after row exists. First creates; second reads.
    const first = await httpGet(port, "/auth/session", TOKEN_RACE);
    expect(first.status).toBe(200);
    const firstBody = first.body as { founderId: string; isNew: boolean };
    expect(firstBody.isNew).toBe(true);

    const second = await httpGet(port, "/auth/session", TOKEN_RACE);
    expect(second.status).toBe(200);
    const secondBody = second.body as { founderId: string; isNew: boolean };
    expect(secondBody.founderId).toBe(firstBody.founderId);
    expect(secondBody.isNew).toBe(false);
  });

  it("missing token → 401 unchanged", async () => {
    const res = await httpGet(port, "/auth/session");
    expect(res.status).toBe(401);
  });

  it("invalid token → 401 unchanged", async () => {
    const res = await httpGet(port, "/auth/session", "not-a-valid-token");
    expect(res.status).toBe(401);
  });

  // intakeComplete is consumed by /vertical-request's server component to
  // decide whether to redirect the founder back to /intake before letting
  // them start a paid run — see apps/web/app/vertical-request/page.tsx.
  it("fresh founder (no intakeState) → intakeComplete: false", async () => {
    const res = await httpGet(port, "/auth/session", TOKEN_RACE);
    expect(res.status).toBe(200);
    const body = res.body as { intakeComplete: boolean };
    expect(body.intakeComplete).toBe(false);
  });

  it("founder with intakeState.completedAt set → intakeComplete: true", async () => {
    // Bootstrap the row via /auth/session, then mark intake complete directly.
    await httpGet(port, "/auth/session", TOKEN_RACE);
    await prisma.founder.update({
      where: { authUserId: AUTH_USER_RACE },
      data: { intakeState: { completedAt: new Date().toISOString() } },
    });

    const res = await httpGet(port, "/auth/session", TOKEN_RACE);
    expect(res.status).toBe(200);
    const body = res.body as { intakeComplete: boolean };
    expect(body.intakeComplete).toBe(true);
  });
});
