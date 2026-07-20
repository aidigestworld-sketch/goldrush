// Canonical enum for the DAG stages, in execution order.
// The strings match dag_run_state.step's CHECK constraint values.
// Kept in one file so migration + queues + handlers + API share one
// source of truth — if the check constraint ever needs to change,
// this constant is what a grep will point to.
//
// opportunity_rationale is a POST_JOIN_STEP — it runs after compression
// as a polish transaction that fills opportunity.rationale_bullets /
// risk_summary. It is NOT part of LINEAR_ORDER or the fork/join topology,
// and the user-visible "completed" derivation ignores it (a still-running
// or failed rationale must not flip the run back to in_progress).

export const DAG_STEPS = [
  "discovery",
  "expansion",
  "filtering",
  "competitive_analysis",
  "hypothesis",
  "validation",
  "confidence_mode1",
  "composition",
  "scoring",
  "confidence_mode2",
  "founder_fit",
  "compression",
  "opportunity_rationale",
] as const;

export type DagStep = (typeof DAG_STEPS)[number];

// The linear-chain portion (everything before the fork/join).
// Scoring's completion triggers the FlowProducer that adds
// confidence_mode2 + founder_fit as children of compression.
export const LINEAR_ORDER: DagStep[] = [
  "discovery",
  "expansion",
  "filtering",
  "competitive_analysis",
  "hypothesis",
  "validation",
  "confidence_mode1",
  "composition",
  "scoring",
];

// Fork/join topology. Both branches must succeed before compression.
export const FORK_CHILDREN: DagStep[] = ["confidence_mode2", "founder_fit"];
export const JOIN_STEP: DagStep = "compression";

// Post-join follow-on. Enqueued by sequencing.advance when compression
// succeeds; not part of any topology group above. Kept as its own concept
// so status-derivation code can filter it explicitly (rather than by
// implicit knowledge of "which one is the polish step").
export const POST_JOIN_STEP: DagStep = "opportunity_rationale";

export const STEP_LABELS: Record<DagStep, string> = {
  discovery: "Discovery",
  expansion: "Expansion",
  filtering: "Filtering",
  competitive_analysis: "Competitive Analysis",
  hypothesis: "Hypothesis Generation",
  validation: "Validation",
  confidence_mode1: "Confidence (Mode 1)",
  composition: "Composition",
  scoring: "Scoring",
  confidence_mode2: "Confidence (Mode 2)",
  founder_fit: "Founder Fit",
  compression: "Compression",
  opportunity_rationale: "Opportunity Rationale",
};

export function nextLinearStep(current: DagStep): DagStep | null {
  const idx = LINEAR_ORDER.indexOf(current);
  if (idx === -1 || idx === LINEAR_ORDER.length - 1) return null;
  return LINEAR_ORDER[idx + 1];
}
