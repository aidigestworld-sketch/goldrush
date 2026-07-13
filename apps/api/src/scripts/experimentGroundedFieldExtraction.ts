// Bench: given the real evidence corpus already in Postgres, would
// adding candidate output fields (margin_profile, capital_intensity_estimate,
// acquisition_channels_known) to the Discovery/Expansion/CompetitiveAnalysis
// sandboxes result in grounded extractions or hallucinations?
//
// Non-invasive. Reads the corpus, wraps each Evidence row in a
// diagnostic prompt that asks the model to attempt grounded
// extraction for EACH candidate field — with the option to return
// null + a reason if the text doesn't support it. Prints what the
// model produced.
//
// The bench doesn't modify any production sandbox prompt. Its
// purpose is to answer one specific question honestly: on real
// corpus text, does a strict grounded-extraction prompt for these
// fields produce nulls (evidence really doesn't support them) or
// numbers (model invents values under pressure)?
//
// Run: npx tsx -r dotenv/config src/scripts/experimentGroundedFieldExtraction.ts
import { NimLLMClient } from "../sandbox/nimLLMClient";
import { modelRoutingConfigRepository } from "../repositories/modelRoutingConfig.repository";
import { prisma } from "../db/client";

const DIAGNOSTIC_PROMPT = `You are a strict grounded-extraction utility. Given a single Evidence document, attempt to extract structured values for the fields below. FOLLOW THESE RULES EXACTLY:

- For each field, if the document's actual text supports a value with an EXACT quotable substring, report the value plus that substring in the "quote" field, verbatim.
- If the document does NOT actually state or clearly imply a value for a field, set the value to null AND write a brief "reason_null" explaining why the text doesn't support it.
- Do NOT infer from category stereotypes, industry averages, or general knowledge about similar businesses/markets. If the text doesn't state it, it is null.
- Pricing information is NOT the same as margin: prices/fees a customer pays are revenue-facing; margin requires COST information. If a document only gives pricing, margin_profile is null.
- A list of businesses is NOT the same as growth rate: a count of companies at a point in time is a state, not a trajectory.

Fields to attempt:
  - margin_profile (float 0.0 to 1.0): the gross margin the business retains after direct costs. Requires an actual COST or MARGIN statement in the text.
  - capital_intensity_estimate (float 0.0 to 1.0): how capital-heavy the business is relative to peers. Requires a stated capital requirement, infrastructure investment, funding round with clear use-of-funds, or similar.
  - acquisition_channels_known (array of strings): named channels through which this business/audience is reached. Requires the text to actually name channels (e.g. "Shopify App Store listing", "content marketing", "partnerships"), not just imply demand for the product exists.
  - growth_rate_estimate (float, decimal e.g. 0.15 for 15%): year-over-year or period-over-period growth rate. Requires an actual growth-rate figure or two data points that establish a rate.

Respond with ONLY valid JSON matching this exact shape:
{
  "margin_profile": { "value": number | null, "quote": string | null, "reason_null": string | null },
  "capital_intensity_estimate": { "value": number | null, "quote": string | null, "reason_null": string | null },
  "acquisition_channels_known": { "value": string[] | null, "quote": string | null, "reason_null": string | null },
  "growth_rate_estimate": { "value": number | null, "quote": string | null, "reason_null": string | null }
}`;

interface ExtractionResult {
  margin_profile: { value: number | null; quote: string | null; reason_null: string | null };
  capital_intensity_estimate: { value: number | null; quote: string | null; reason_null: string | null };
  acquisition_channels_known: { value: string[] | null; quote: string | null; reason_null: string | null };
  growth_rate_estimate: { value: number | null; quote: string | null; reason_null: string | null };
}

async function main() {
  const config = await modelRoutingConfigRepository.latestForAgent("CompetitiveAnalysis");
  if (!config) throw new Error("no model_routing_config for CompetitiveAnalysis");
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("NVIDIA_API_KEY not set");
  const llm = new NimLLMClient(key, config.nimModelId);
  console.log(`Model: ${config.nimModelId} (tier ${config.tier})\n`);

  // Test against representative Evidence from each source type that
  // the target agents actually consume:
  const targetIds = [
    "fe991ccf-a812-4bb2-8762-34614d58528c", // competitor_material — Recharge pricing/tiers
    "40044b8c-9803-441a-9da1-3534365ccd13", // competitor_material — Loop pricing + "400 brands migrated"
    "d84beda8-6874-4655-bd48-4d59726b190b", // competitor_material — Bold pricing
    "bb77bb02-4ff6-4dc3-ac72-07809b6e29a0", // marketplace — Shopify App Store snapshot
    "274f4950-7c0e-41bd-a3f1-afb830ec1899", // financial_signal — Recharge acquired Skio $105M
    "4ddc58f8-a8c5-4340-9a45-72cc27056cc8", // industry_report — churn framing
    "047730c0-d4b6-478a-99e5-611cb98a145a", // review_complaint — merchant Shop Pay pain
  ];
  const rows = await prisma.evidence.findMany({ where: { id: { in: targetIds } } });
  console.log(`Testing ${rows.length} real Evidence rows.\n`);

  const results: {
    id: string;
    source_type: string;
    parsed: ExtractionResult | null;
    parseError?: string;
    raw: string;
  }[] = [];

  for (const row of rows) {
    console.log(`\n──────── ${row.sourceType} — ${row.id.slice(0, 8)} ────────`);
    const userPrompt = `[document id="${row.id}" source_type="${row.sourceType}"]\n${row.extractedFact}\n[/document]`;
    const raw = await llm.complete(DIAGNOSTIC_PROMPT, userPrompt);
    const jsonBlock = extractJsonBlock(raw);
    let parsed: ExtractionResult | null = null;
    let parseError: string | undefined;
    if (jsonBlock) {
      try {
        parsed = JSON.parse(jsonBlock);
      } catch (err) {
        parseError = (err as Error).message;
      }
    } else {
      parseError = "no JSON block";
    }
    results.push({ id: row.id, source_type: row.sourceType, parsed, parseError, raw });
    if (parsed) {
      for (const [field, r] of Object.entries(parsed) as [keyof ExtractionResult, ExtractionResult[keyof ExtractionResult]][]) {
        const v = r.value;
        const badge = v === null || (Array.isArray(v) && v.length === 0) ? "[null]" : "[VALUE]";
        console.log(`  ${badge} ${field}: value=${JSON.stringify(v)}${r.quote ? ` quote="${r.quote.slice(0, 60)}"` : ""}${r.reason_null ? ` reason="${r.reason_null.slice(0, 80)}"` : ""}`);
      }
    } else {
      console.log(`  PARSE ERROR: ${parseError}`);
    }
  }

  console.log("\n\n============ SUMMARY (grounded / null / parse-error) ============");
  const summary: Record<string, { grounded: number; nullish: number; parseError: number }> = {
    margin_profile: { grounded: 0, nullish: 0, parseError: 0 },
    capital_intensity_estimate: { grounded: 0, nullish: 0, parseError: 0 },
    acquisition_channels_known: { grounded: 0, nullish: 0, parseError: 0 },
    growth_rate_estimate: { grounded: 0, nullish: 0, parseError: 0 },
  };
  for (const r of results) {
    if (!r.parsed) {
      for (const k of Object.keys(summary)) summary[k].parseError++;
      continue;
    }
    for (const [k, v] of Object.entries(r.parsed) as [keyof ExtractionResult, ExtractionResult[keyof ExtractionResult]][]) {
      const val = v.value;
      if (val === null || (Array.isArray(val) && val.length === 0)) summary[k].nullish++;
      else summary[k].grounded++;
    }
  }
  console.table(summary);

  console.log("\n============ GROUNDED VALUES (if any — need substring-check verification) ============");
  for (const r of results) {
    if (!r.parsed) continue;
    for (const [k, v] of Object.entries(r.parsed) as [keyof ExtractionResult, ExtractionResult[keyof ExtractionResult]][]) {
      const val = v.value;
      if (val !== null && !(Array.isArray(val) && val.length === 0)) {
        console.log(`\n[${r.source_type} ${r.id.slice(0, 8)}] ${k} = ${JSON.stringify(val)}`);
        console.log(`  claimed quote: "${v.quote}"`);
      }
    }
  }

  await prisma.$disconnect();
}

function extractJsonBlock(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.substring(start, i + 1);
    }
  }
  return null;
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
