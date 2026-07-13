// Filtering Agent — deterministic rule evaluation only, no model call
// (AI_AGENTS.md §3). Prunes structural nodes below a confidence
// threshold. Thresholds are configuration, read not computed —
// callers own where the config value comes from; this function is
// pure so it's testable without any config-loading machinery.
export interface FilterableNode {
  id: string;
  confidence: number | null;
}

export interface FilterThresholds {
  minConfidence: number;
}

export interface FilterDecision {
  id: string;
  survived: boolean;
  deprecationReason?: string;
}

export function applyFiltering(nodes: FilterableNode[], thresholds: FilterThresholds): FilterDecision[] {
  return nodes.map((node) => {
    if (node.confidence === null || node.confidence < thresholds.minConfidence) {
      return {
        id: node.id,
        survived: false,
        deprecationReason: node.confidence === null ? "missing_confidence" : "below_confidence_threshold",
      };
    }
    return { id: node.id, survived: true };
  });
}
