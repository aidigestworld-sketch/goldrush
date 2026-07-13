// Intake Extraction Agent — live wrapper for intakeExtractionSandbox.
//
// Called once per interview turn, immediately after the founder answers
// a question. Extracts structured values so contradiction detection can
// work against real structured data rather than raw text.
//
// Pattern: same as founderFitAgent.ts / compressionAgent.ts — calls NIM
// via the sandbox, validates output against the Zod schema, returns a
// typed result, and wraps execution in agentExecutionLogService.run for
// consistent logging/observability.
//
// runId note: intake turns are per-founder, not per-pipeline-run. We use
// founderId as the log's runId since the agent_execution_log table treats
// runId as an opaque string identifier. If a FK constraint on
// agent_execution_log.run_id ever references pipeline_run.run_id, the
// intake flow will need a synthetic pipeline_run row or a separate log
// table.
import {
  runIntakeExtractionSandbox,
  type IntakeExtractionInput,
  type IntakeExtractionOutput,
} from "../../sandbox/intakeExtractionSandbox";
import type { LLMClient } from "../../sandbox/llmClient";
import { agentExecutionLogService } from "../../services/agentExecutionLog.service";

export interface IntakeExtractionRunResult {
  output: IntakeExtractionOutput | null;
  validationErrors: string[];
  skipped: boolean;
  skipReason?: string;
}

export async function runIntakeExtractionAgent(
  founderId: string,
  input: IntakeExtractionInput,
  llm: LLMClient
): Promise<IntakeExtractionRunResult> {
  return agentExecutionLogService.run(
    {
      runId: null,
      agentName: "IntakeExtraction",
      candidateId: null,
      modelUsed: (llm as { model?: string }).model ?? null,
    },
    async () => {
      const result = await runIntakeExtractionSandbox(llm, input);
      if (!result.parsed) {
        return {
          output: null,
          validationErrors: result.validationErrors,
          skipped: true,
          skipReason: `Schema validation failed: ${result.validationErrors.join("; ")}`,
        };
      }
      return {
        output: result.parsed,
        validationErrors: [],
        skipped: false,
      };
    },
    // graphMutationCount = 1 for a successful extraction (1 evidence row
    // will be written by the caller via saveIntakeTurn); 0 if skipped.
    (result) => ({ graphMutationCount: result.skipped ? 0 : 1 })
  );
}

// Convert the extraction output to a single string for storage in the
// founder_evidence.extracted_value TEXT column.
//
// expertise / distributionAssets: items joined with "; " so the string
//   is human-readable and each call's items become one evidence row entry.
//   deriveProfileFromEvidence maps each row's extractedValue to one array
//   slot — the join means all domain terms from one answer land together.
//
// capitalAvailability: the normalized label directly.
//
// null / empty: "" — deriveProfileFromEvidence filters empty strings so
//   a nothing-extractable turn leaves no phantom entries in the profile.
export function extractionOutputToString(output: IntakeExtractionOutput | null): string {
  if (!output) return "";
  if (output.field === "capitalAvailability") return output.extracted ?? "";
  return (output.extracted ?? []).join("; ");
}
