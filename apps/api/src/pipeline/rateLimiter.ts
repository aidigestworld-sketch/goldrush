// Simple per-domain rate limiter using Redis as the shared counter —
// shared, not per-process, deliberately: multiple pipeline_run's
// Discovery/Expansion/CompetitiveAnalysis calls (AGENT_EXECUTION_DAG.md
// §6, concurrent runs) must not each independently hammer the same
// external domain. One counter per domain, visible to every run.
import Redis from "ioredis";

export class DomainRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly maxRequestsPerWindow: number,
    private readonly windowSeconds: number
  ) {}

  private key(domain: string): string {
    return `pipeline:ratelimit:${domain}`;
  }

  // Returns true if the request is allowed (and counts it); false if
  // the domain's window is already exhausted. Callers should back off
  // and retry later on false, not busy-loop.
  async tryAcquire(domain: string): Promise<boolean> {
    const key = this.key(domain);
    const count = await this.redis.incr(key);
    if (count === 1) {
      // first request in this window — start the TTL clock
      await this.redis.expire(key, this.windowSeconds);
    }
    return count <= this.maxRequestsPerWindow;
  }
}
