import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the server-side Supabase client factory before the route module is
// imported. The route calls createClient() and then .from(...).insert(...).
const insertMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ insert: insertMock }),
  }),
}));

import { POST } from "@/app/api/waitlist/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/waitlist", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    insertMock.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("rejects malformed JSON with 400", async () => {
    const req = new Request("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects a non-email string with 400 and never touches the DB", async () => {
    const res = await POST(jsonRequest({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("silently 200s on honeypot without inserting", async () => {
    const res = await POST(
      jsonRequest({ email: "founder@example.com", website: "http://spam" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("normalizes email (trim + lowercase) before insert on success", async () => {
    insertMock.mockResolvedValue({ error: null });
    const res = await POST(jsonRequest({ email: "  Founder@Example.COM  " }));
    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledWith({
      email: "founder@example.com",
      source: "landing",
    });
  });

  it("treats unique_violation (23505) as success (no enumeration leak)", async () => {
    insertMock.mockResolvedValue({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const res = await POST(jsonRequest({ email: "founder@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // ── THE REGRESSION TEST ─────────────────────────────────────────────
  // The bug that shipped: migration 017 was never applied to Supabase,
  // so PostgREST returned PGRST205 ("Could not find the table
  // 'public.waitlist_signups'"). The route silently returned 500 and the
  // form showed "Something went wrong". The existing WaitlistForm test
  // mocked fetch entirely so this path was never exercised.
  //
  // This test would have failed at CI time by asserting that a
  // schema-cache-miss surfaces the underlying error to server logs
  // (making the failure diagnosable) rather than being swallowed.
  it("surfaces PGRST205 (table missing) to logs and returns 500", async () => {
    insertMock.mockResolvedValue({
      error: {
        code: "PGRST205",
        message: "Could not find the table 'public.waitlist_signups' in the schema cache",
        details: null,
        hint: null,
      },
    });
    const res = await POST(jsonRequest({ email: "founder@example.com" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_error" });

    // The whole point of adding this diagnostic: server logs must name
    // the actual Postgres/PostgREST error so a missing migration or
    // RLS regression isn't invisible again.
    expect(errorSpy).toHaveBeenCalled();
    const logged = String(errorSpy.mock.calls[0][1] ?? "");
    expect(logged).toContain("PGRST205");
    expect(logged).toContain("waitlist_signups");
  });

  it("returns 500 for any other non-23505 Supabase error", async () => {
    insertMock.mockResolvedValue({
      error: { code: "42501", message: "permission denied for table waitlist_signups" },
    });
    const res = await POST(jsonRequest({ email: "founder@example.com" }));
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
  });
});
