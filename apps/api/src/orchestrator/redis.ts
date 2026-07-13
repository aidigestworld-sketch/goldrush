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
import type { ConnectionOptions } from "bullmq";

export function getRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
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
