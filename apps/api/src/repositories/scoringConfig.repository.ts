// Read access for scoring_config. Memory Agent is the only writer
// (AI_AGENTS.md §12) — this repository is deliberately read-only;
// writing new versions belongs to Memory Agent's own code path, not
// here.
import { prisma } from "../db/client";

export const scoringConfigRepository = {
  // Scoring Agent's own read pattern, AI_AGENTS.md §10 / DATABASE_SCHEMA.md §3.12:
  // latest version for a given vertical.
  latestForVertical(vertical: string) {
    return prisma.scoringConfig.findFirst({
      where: { vertical },
      orderBy: { version: "desc" },
    });
  },
};
