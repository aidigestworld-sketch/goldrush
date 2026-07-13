// Captured from NIM model (meta/llama-3.1-70b-instruct) during the
// b2b_customer_support_saas generalizationProbeIsolated run.
//
// Failure mode: the model emitted a literal newline character (U+000A) inside
// the "current_workaround_description" string for the second problem — JSON
// strings must encode newlines as \n, not as raw 0x0A, so JSON.parse throws at
// the position where the literal newline appears.
//
// Approximate failure position: ~1789 chars into the raw NIM HTTP response
// body (= ~190-char envelope prefix + ~1599 chars of model output content).
// The Shopify vertical never hit this because its evidence text is shorter and
// the model produces fewer/shorter workaround descriptions; the B2B domain
// produces more verbose free-text in that field.
//
// Used by expansionSandbox.test.ts to pin the jsonrepair recovery path against
// the real malformed fragment.
export const b2bNimMalformedRawContent = `{
  "audiences": [
    {
      "label": "IT support teams at mid-market B2B SaaS companies",
      "description": "Teams responsible for internal help desk operations where SLA adherence and ticket triage are primary operational concerns.",
      "evidence_refs": ["b2b-doc-01", "b2b-doc-02"]
    },
    {
      "label": "Employees submitting internal IT tickets at companies using help desk software",
      "description": "End users who open tickets and are affected by slow resolution times, unacknowledged requests, and lack of escalation visibility.",
      "evidence_refs": ["b2b-doc-03"]
    }
  ],
  "problems": [
    {
      "label": "No automated triage to prioritize tickets by urgency before human review, causing SLA breaches during high-volume periods",
      "problem_maturity": "recognized_unsolved",
      "current_workaround_description": null,
      "severity_signal": null,
      "severity_evidence_quote": null,
      "frequency_signal": 0.7,
      "frequency_evidence_quote": "widely reported pain point",
      "evidence_refs": ["b2b-doc-01"]
    },
    {
      "label": "Missing queue-health visibility during platform slowdowns, forcing agents to duplicate effort on tickets they cannot confirm were received",
      "problem_maturity": "recognized_unsolved",
      "current_workaround_description": "Agents manually refresh the queue interface
repeatedly to check for delayed tickets, but this does not reliably surface delayed items and increases cognitive overhead during high-volume periods.",
      "severity_signal": null,
      "severity_evidence_quote": null,
      "frequency_signal": null,
      "frequency_evidence_quote": null,
      "evidence_refs": ["b2b-doc-02"]
    },
    {
      "label": "No automatic escalation path when tickets exceed a resolution threshold, causing silent stalls with no notification to submitter or supervisor",
      "problem_maturity": "recognized_unsolved",
      "current_workaround_description": null,
      "severity_signal": null,
      "severity_evidence_quote": null,
      "frequency_signal": null,
      "frequency_evidence_quote": null,
      "evidence_refs": ["b2b-doc-03"]
    }
  ]
}`;
