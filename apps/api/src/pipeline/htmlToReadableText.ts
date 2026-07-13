// Converts raw HTML into readable markdown-ish text — the same kind
// of content the shopifyAppStoreReviews.normalizer.ts fixture was
// built from (originally produced by a different tool's fetch+convert
// step; this is our own equivalent for the app's real connector path).
//
// Deliberately chosen over CSS-selector scraping (cheerio against
// specific class names): Shopify's App Store markup uses generated/
// hashed class names (e.g. "eco-modal-close-b200ad2b..."), so
// selector-based scraping would be brittle against routine front-end
// rebuilds. Readability + markdown conversion is slower per-page but
// much more stable — it degrades gracefully to "extract the main
// textual content" rather than breaking outright when a class name
// changes.
//
// HONEST CAVEAT: this has only been smoke-tested against generic HTML
// in the sandbox this was written in (no network access to fetch a
// real Shopify page there). The normalizer's regex patterns were
// verified against a real fixture from the live page, produced by a
// different extraction path — there is a real, not yet closed risk
// that THIS specific extractor's markdown output differs enough
// (spacing, heading levels, link formatting) that the normalizer's
// regexes need adjusting. Verify this end-to-end once real network
// access is available, before trusting it in Phase 4.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const turndown = new TurndownService({ headingStyle: "atx" });

export function htmlToReadableText(rawHtml: string, url: string): string {
  const dom = new JSDOM(rawHtml, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article?.content) {
    // Fall back to the raw body text rather than throwing — an empty
    // normalization result downstream is a legitimate, visible failure
    // mode (zero evidence rows), preferable to crashing the whole
    // ingestion run over one unparseable page.
    return dom.window.document.body?.textContent ?? "";
  }
  return turndown.turndown(article.content);
}
