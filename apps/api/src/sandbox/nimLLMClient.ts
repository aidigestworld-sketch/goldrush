// Real NIM (build.nvidia.com) client — OpenAI-compatible endpoint,
// confirmed via docs.nvidia.com/nim and NVIDIA's own examples:
// https://integrate.api.nvidia.com/v1/chat/completions, Bearer auth
// with an nvapi-... key.
//
// This implements the same LLMClient interface as
// AnthropicLLMClient (llmClient.ts) — swapping between them is a
// one-line change, by design. This is the client production
// Discovery/Expansion/CompetitiveAnalysis agents should actually use,
// per model_routing_config's nim_model_id per agent.
import type { LLMClient } from "./llmClient";

export class NimLLMClient implements LLMClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string = "https://integrate.api.nvidia.com/v1"
  ) {}

  // 10-minute ceiling per call. Legitimate calls on the 49B model have
  // been observed at 2–9 min; indefinite hangs would otherwise block
  // BullMQ's retry mechanism forever.
  private static readonly TIMEOUT_MS = 10 * 60 * 1000;

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NimLLMClient.TIMEOUT_MS);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2, // low temperature — this is structured extraction, not creative generation
        max_tokens: 4096, // raised from 2048 during V8 rollout (confidenceSandbox.ts): the V8 schema's per_evidence_answers_question map + rationale can exceed 2048 tokens on 10-item pools, which was truncating output mid-JSON on the bench's first attempt. 4096 gives headroom without significantly changing per-call cost.
      }),
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      throw new Error(`NIM API error (model=${this.model}): ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason === "length") {
      console.warn(
        `[NimLLMClient] model=${this.model} finish_reason=length — output was truncated at max_tokens (${4096}); ` +
          "if JSON is malformed this is the cause, consider raising max_tokens"
      );
    }
    return data.choices?.[0]?.message?.content ?? "";
  }
}
