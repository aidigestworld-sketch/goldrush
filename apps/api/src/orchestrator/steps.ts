// Canonical enum for the 12 DAG stages, in execution order.
// The strings match dag_run_state.step's CHECK constraint values.
// Kept in one file so migration + queues + handlers + API share one
// source of truth — if the check constraint ever needs to change,
// this constant is what a grep will point to.

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
};

export function nextLinearStep(current: DagStep): DagStep | null {
  const idx = LINEAR_ORDER.indexOf(current);
  if (idx === -1 || idx === LINEAR_ORDER.length - 1) return null;
  return LINEAR_ORDER[idx + 1];
}
