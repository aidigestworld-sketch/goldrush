// Bootstraps the Phase 6 Orchestrator HTTP server + worker pool.
// Same shape as runXLive.ts: a persistent runner so it can be re-invoked
// in future sessions without cargo-culted setup.
//
// Run: npx tsx -r dotenv/config src/scripts/runOrchestratorServer.ts
import { startServer } from "../api/server";

async function main() {
  const started = await startServer();
  process.on("SIGINT", async () => {
    console.log("\n[api] SIGINT — shutting down");
    await started.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
