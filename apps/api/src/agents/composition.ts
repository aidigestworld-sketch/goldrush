// Composition Agent — deterministic graph-wiring, no model call
// (AI_AGENTS.md §8/GRAPH_SCHEMA.md §2.9). Instantiates an
// OpportunityCandidate only when all five roles (market, audience,
// problem, hypothesis, business_model) resolve to an active row —
// an incomplete chain is rejected, not scored as low-confidence.
export interface ComposableNode {
  id: string;
  status: string; // must be 'active' to count
}

export interface CompositionInput {
  market: ComposableNode | null;
  audience: ComposableNode | null;
  problem: ComposableNode | null;
  hypothesis: ComposableNode | null;
  businessModel: ComposableNode | null;
}

export type CompositionRole = "market" | "audience" | "problem" | "hypothesis" | "business_model";

export interface CompositionResult {
  success: boolean;
  missingOrInactiveRoles: CompositionRole[];
  composition?: { role: CompositionRole; nodeId: string }[];
}

export function composeCandidate(input: CompositionInput): CompositionResult {
  const roleMap: Record<CompositionRole, ComposableNode | null> = {
    market: input.market,
    audience: input.audience,
    problem: input.problem,
    hypothesis: input.hypothesis,
    business_model: input.businessModel,
  };

  const missingOrInactiveRoles: CompositionRole[] = [];
  for (const [role, node] of Object.entries(roleMap) as [CompositionRole, ComposableNode | null][]) {
    if (!node || node.status !== "active") {
      missingOrInactiveRoles.push(role);
    }
  }

  if (missingOrInactiveRoles.length > 0) {
    return { success: false, missingOrInactiveRoles };
  }

  const composition = (Object.entries(roleMap) as [CompositionRole, ComposableNode | null][]).map(
    ([role, node]) => ({ role, nodeId: node!.id })
  );

  return { success: true, missingOrInactiveRoles: [], composition };
}
