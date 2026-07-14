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
  // nvidia/nvidia-nemotron-nano-9b-v2 max output ceiling is 32768 tokens
  // (per NVIDIA API docs). 16384 is the new default — half the ceiling,
  // enough headroom for Discovery (large markets[] arrays) and Expansion
  // (problems[] with verbatim quote fields) without risk of a hard API
  // error. Raised from 4096 which was truncating Discovery live runs.
  static readonly DEFAULT_MAX_TOKENS = 16384;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string = "https://integrate.api.nvidia.com/v1",
    private readonly maxTokens: number = NimLLMClient.DEFAULT_MAX_TOKENS
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
        max_tokens: this.maxTokens,
      }),
    }).finally(() => clearTimeout(timer));
    if (!response.ok) {
      throw new Error(`NIM API error (model=${this.model}): ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason === "length") {
      // Throw immediately rather than returning truncated JSON — the caller
      // would receive malformed JSON that fails schema validation, producing
      // a confusing "Unexpected end of JSON input" error with no indication
      // of the real cause. Retrying at the same budget won't help; the error
      // message tells the operator exactly what to fix instead.
      throw new Error(
        `[NimLLMClient] model=${this.model} finish_reason=length — output truncated at max_tokens=${this.maxTokens}. ` +
          "Retrying with the same budget will not recover. Raise maxTokens or reduce input scope."
      );
    }
    return data.choices?.[0]?.message?.content ?? "";
  }
}
