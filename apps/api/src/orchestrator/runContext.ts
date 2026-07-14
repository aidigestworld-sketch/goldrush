// Per-run context: metadata every handler needs (the founder id for
// FounderFit, the vertical for Scoring/Compression, the seed
// hypothesis id, the seed problem id derived from that hypothesis).
//
// Cached in-memory across a single process's worker lifetime because
// pipeline_run rows are immutable in these fields — reload per job
// isn't necessary, but the cache is scoped to (runId) so parallel
// orchestrations don't collide.
import { prisma } from "../db/client";

export interface RunContext {
  runId: string;
  founderId: string;
  vertical: string;
  hypothesisId: string; // seed hypothesis for this orchestration
  problemId: string; // derived from hypothesis.hypothesis_sources
}

const cache = new Map<string, RunContext>();

export async function loadRunContext(runId: string, hypothesisId?: string): Promise<RunContext> {
  const cached = cache.get(runId);
  if (cached) return cached;

  const run = await prisma.pipelineRun.findUnique({ where: { runId } });
  if (!run) throw new Error(`pipeline_run ${runId} not found`);

  // Resolve problemId via hypothesis_sources (Composition expects
  // exactly one problem per hypothesis).
  const sources = hypothesisId
    ? await prisma.hypothesisSource.findMany({ where: { hypothesisId } })
    : [];
  const problemIds = [...new Set(sources.map((s) => s.problemId))];
  if (problemIds.length !== 1) {
    // Not a fatal error at context-load time — some early stages
    // (discovery/expansion) don't need problemId. Handlers that DO
    // need it must guard on this value. Default to "" to make the
    // TS types tidy while still triggering downstream skips.
  }

  const ctx: RunContext = {
    runId,
    founderId: run.founderId,
    vertical: run.vertical,
    hypothesisId: hypothesisId ?? "",
    problemId: problemIds[0] ?? "",
  };
  cache.set(runId, ctx);
  return ctx;
}

export function invalidateRunContext(runId: string): void {
  cache.delete(runId);
}
