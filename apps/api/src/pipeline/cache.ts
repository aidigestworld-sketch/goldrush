// Redis-backed fetch cache. Deliberately dumb: key = URL, value =
// RawDocument JSON, TTL = freshness window. This is what
// MVP_IMPLEMENTATION_PLAN.md Phase 0 meant by "Redis: session/cache
// layer for Data Pipeline's rate-limiting and caching" — the Data
// Pipeline should never re-fetch a URL it already has a fresh copy
// of, both to be a polite scraper and to keep re-runs cheap.
import Redis from "ioredis";
import type { RawDocument } from "./types";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h — a source doesn't need refetching more than daily for MVP volume

export class FetchCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS
  ) {}

  private key(url: string): string {
    return `pipeline:cache:${url}`;
  }

  async get(url: string): Promise<RawDocument | null> {
    const raw = await this.redis.get(this.key(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RawDocument;
    // Dates don't survive JSON round-trip as Date objects
    parsed.fetchedAt = new Date(parsed.fetchedAt);
    return parsed;
  }

  async set(url: string, doc: RawDocument): Promise<void> {
    await this.redis.set(this.key(url), JSON.stringify(doc), "EX", this.ttlSeconds);
  }
}
