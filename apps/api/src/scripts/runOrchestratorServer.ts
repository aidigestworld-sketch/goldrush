// Bootstraps the Phase 6 Orchestrator HTTP server + worker pool.
// Same shape as runXLive.ts: a persistent runner so it can be re-invoked
// in future sessions without cargo-culted setup.
//
// Run: npx tsx -r dotenv/config src/scripts/runOrchestratorServer.ts
import { startServer } from "../api/server";

async function main() {
  const started = await startServer();

  // SIGTERM matters as much as SIGINT: `tsx watch` (npm run dev) sends
  // SIGTERM on any source-file save to restart the process. Without a
  // handler, the process is torn down mid-job — BullMQ workers never
  // release their Redis locks cleanly, jobs get marked stalled, and the
  // dag_run_state row is left at 'running' (recoverable now by the
  // startup reconciler, but still noisy). SIGINT is the Ctrl+C case.
  //
  // Both handlers call started.stop(), which calls stopWorkers() →
  // BullMQ Worker.close(), which waits for the currently-processing job
  // to finish or move the lock cleanly, then unsubscribes from Redis.
  //
  // Guard against multiple concurrent signals (e.g. Ctrl+C twice) so
  // the async close-and-exit only runs once.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[api] ${signal} — shutting down gracefully (releasing BullMQ locks, closing HTTP server)`);
    try {
      await started.stop();
      process.exit(0);
    } catch (err) {
      console.error("[api] shutdown error:", err);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
