// Orchestrates one ingestion pass: cache-check -> rate-limit ->
// connector.fetch -> HTML-to-readable-text -> normalize ->
// verification sampling -> persist to evidence table.
//
// This is Data Pipeline's own code, NOT an agent (AI_AGENTS.md §0
// rejected NVIDIA-draft idea #2: ingestion stays a separate
// non-agent subsystem so caching/rate-limiting/verification aren't
// silently lost if ingestion were folded into Discovery/Expansion's
// own responsibilities).
import type { Connector, RawDocument, NormalizedEvidence } from "./types";
import { FetchCache } from "./cache";
import { DomainRateLimiter } from "./rateLimiter";
import { htmlToReadableText } from "./htmlToReadableText";
import { selectVerificationSample } from "./verificationSampler";
import { evidenceRepository } from "../repositories/evidence.repository";

export interface IngestOptions {
  target: string;
  domain: string; // for rate-limiting, e.g. "apps.shopify.com"
  verificationSampleRate?: number; // default 0.1 (10%)
  // Vertical tag applied to every persisted evidence row. Migration
  // 008: Discovery reads evidence scoped by vertical, so ingesting
  // without one produces orphan rows no run will ever pick up.
  vertical: string;
}

export interface IngestResult {
  cacheHit: boolean;
  rateLimited: boolean;
  rawDocumentCount: number;
  normalizedCount: number;
  persistedCount: number;
  sampledForVerificationCount: number;
}

export class IngestPipeline {
  constructor(
    private readonly connector: Connector,
    private readonly cache: FetchCache,
    private readonly rateLimiter: DomainRateLimiter,
    // normalize: turns one RawDocument's readable text into zero or
    // more NormalizedEvidence rows. Injected rather than hardcoded so
    // this same orchestrator works for every connector/normalizer pair
    // (reviews, listings, forums, ...), not just one.
    private readonly normalize: (readableText: string, sourceUrl: string, fetchedAt: Date) => NormalizedEvidence[]
  ) {}

  async run(options: IngestOptions): Promise<IngestResult> {
    const cached = await this.cache.get(this.cacheKeyFor(options.target));
    let rawDocs: RawDocument[];
    let cacheHit = false;

    if (cached) {
      rawDocs = [cached];
      cacheHit = true;
    } else {
      const allowed = await this.rateLimiter.tryAcquire(options.domain);
      if (!allowed) {
        return {
          cacheHit: false,
          rateLimited: true,
          rawDocumentCount: 0,
          normalizedCount: 0,
          persistedCount: 0,
          sampledForVerificationCount: 0,
        };
      }
      rawDocs = await this.connector.fetch(options.target);
      for (const doc of rawDocs) {
        await this.cache.set(this.cacheKeyFor(options.target), doc);
      }
    }

    const allNormalized: NormalizedEvidence[] = [];
    for (const doc of rawDocs) {
      const readableText =
        doc.contentType === "html" ? htmlToReadableText(doc.rawContent, doc.sourceUrlOrIdentifier) : doc.rawContent;
      allNormalized.push(...this.normalize(readableText, doc.sourceUrlOrIdentifier, doc.fetchedAt));
    }

    const sampleDecisions = selectVerificationSample(
      allNormalized.length,
      options.verificationSampleRate ?? 0.1
    );
    const sampledCount = sampleDecisions.filter((d) => d.shouldSample).length;
    // MVP: sampled rows are flagged for follow-up review, not
    // auto-verified — see verificationSampler.ts's own comment. The
    // `evidence.verification_status` column stays 'unverified' for
    // now regardless; a future review-queue mechanism would update it.

    const persisted = await evidenceRepository.createMany(allNormalized, options.vertical);

    return {
      cacheHit,
      rateLimited: false,
      rawDocumentCount: rawDocs.length,
      normalizedCount: allNormalized.length,
      persistedCount: persisted.count,
      sampledForVerificationCount: sampledCount,
    };
  }

  private cacheKeyFor(target: string): string {
    return `${this.connector.name}:${target}`;
  }
}
