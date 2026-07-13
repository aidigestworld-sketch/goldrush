// Real end-to-end test of IngestPipeline against a REAL Redis
// instance and REAL Prisma persistence — the sandbox this was written
// in could only test this with a fake in-memory evidence repository
// (no generated @prisma/client available there). This is the first
// real run of the full cache -> rate-limit -> normalize -> persist
// chain.
//
// PREREQUISITE: a local Redis must be running and reachable at the
// default location ioredis expects (localhost:6379), or set REDIS_URL.
// If you don't have one yet:
//   docker run --name oe-redis -p 6379:6379 -d redis:7
//
// Run: npx tsx -r dotenv/config src/pipeline/__tests__/ingest.test.ts
import * as fs from "fs";
import * as path from "path";
import Redis from "ioredis";
import { IngestPipeline } from "../ingest";
import { FetchCache } from "../cache";
import { DomainRateLimiter } from "../rateLimiter";
import { normalizeShopifyAppStoreReviews } from "../normalizers/shopifyAppStoreReviews.normalizer";
import type { Connector, RawDocument } from "../types";
import { prisma } from "../../db/client";

const TEST_URL = "https://test-fixture.local/ingest-test/skio/reviews";

class FixtureConnector implements Connector {
  readonly name = "shopify-app-store-reviews-test";
  readonly sourceType = "review_complaint" as const;
  private callCount = 0;

  async fetch(): Promise<RawDocument[]> {
    this.callCount++;
    const fixturePath = path.join(__dirname, "..", "__fixtures__", "skio-reviews-page.md");
    const rawContent = fs.readFileSync(fixturePath, "utf-8");
    return [
      {
        sourceUrlOrIdentifier: TEST_URL,
        sourceType: this.sourceType,
        fetchedAt: new Date(),
        rawContent,
        contentType: "json", // fixture is plain text already, skip HTML->readable step
      },
    ];
  }

  getCallCount() {
    return this.callCount;
  }
}

let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "✓" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
}

async function main() {
  const redis = new Redis();
  const connector = new FixtureConnector();
  const cache = new FetchCache(redis, 3600);
  const rateLimiter = new DomainRateLimiter(redis, 100, 60);
  const pipeline = new IngestPipeline(connector, cache, rateLimiter, normalizeShopifyAppStoreReviews);

  try {
    // Clean slate for this specific test target only — do not flush the whole Redis DB
    await redis.del(`${connector.name}:test-target`);

    const result1 = await pipeline.run({ target: "test-target", domain: "test-fixture.local", vertical: "shopify_subscriptions" });
    check(result1.cacheHit === false, "first run is a cache miss");
    check(result1.normalizedCount === 3, `first run normalizes 3 reviews from fixture (got ${result1.normalizedCount})`);
    check(result1.persistedCount === 3, `first run persists 3 rows to real Postgres (got ${result1.persistedCount})`);
    check(connector.getCallCount() === 1, "connector called exactly once so far");

    const result2 = await pipeline.run({ target: "test-target", domain: "test-fixture.local", vertical: "shopify_subscriptions" });
    check(result2.cacheHit === true, "second run (same target) is a cache HIT");
    check(connector.getCallCount() === 1, "connector NOT called again on cache hit");

    const persisted = await prisma.evidence.findMany({ where: { sourceUrlOrIdentifier: TEST_URL } });
    check(persisted.length === 6, `real Postgres has 6 rows total after 2 runs — 3 persisted each run (got ${persisted.length})`);
  } finally {
    await prisma.evidence.deleteMany({ where: { sourceUrlOrIdentifier: TEST_URL } });
    await redis.del(`${connector.name}:test-target`);
    await redis.quit();
    await prisma.$disconnect();
  }

  console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
