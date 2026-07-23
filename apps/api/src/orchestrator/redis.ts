// Connection options object shared with every BullMQ Queue / Worker /
// FlowProducer. BullMQ requires `maxRetriesPerRequest: null` on
// connections it holds long-term — otherwise `bclient`-style blocking
// commands abort with `MaxRetriesPerRequestError`.
//
// We pass options (not an ioredis instance) because BullMQ bundles its
// own ioredis internally — passing a locally-constructed instance
// triggers a nominal-typing mismatch between the two copies.
//
// The env override REDIS_URL exists so tests can point at a separate
// db index (redis://localhost:6379/1) without touching the app default.
//
// In production, REDIS_URL is required. Silently falling back to
// redis://localhost:6379 hid a broken Railway variable reference behind a
// 20-second ECONNREFUSED retry loop (from reconcileStuckRunningSteps) for
// hours — impossible to notice unless you were tailing the logs. Now we
// throw at first use in production so the failure is loud and immediate.
// Dev/test still get the localhost default so `npm test` and local dev
// against a locally-running redis-server keep working without extra env
// wiring.
import type { ConnectionOptions } from "bullmq";

export function getRedisConnection(): ConnectionOptions {
  const envUrl = process.env.REDIS_URL;
  if (!envUrl && process.env.NODE_ENV === "production") {
    throw new Error(
      "REDIS_URL is not set — set it in Railway to the Redis service's " +
        "connection string (e.g. ${{Redis.REDIS_URL}}). Refusing to fall " +
        "back to redis://localhost:6379 in production."
    );
  }
  const url = envUrl ?? "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname || "localhost",
    port: parsed.port ? Number(parsed.port) : 6379,
    db: parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : 0,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

// Kept for API compatibility with a future switch back to instance-mode.
export async function closeRedis(): Promise<void> {
  /* no-op; BullMQ manages its own connections */
}
