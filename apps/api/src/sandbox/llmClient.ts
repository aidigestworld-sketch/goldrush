// Pluggable LLM client interface — the Sandbox scripts don't care
// whether calls go to NIM (build.nvidia.com, the project's actual
// model-routing decision, AI_AGENTS.md §16) or directly to Anthropic
// for local testing convenience. Swap implementations without
// touching sandbox/prompt code.
export interface LLMClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

// Real Anthropic implementation — usable today since api.anthropic.com
// is reachable and you likely already have a key for other projects.
// NOT what production Discovery/Expansion/CompetitiveAnalysis agents
// will call (that's NIM, per model_routing_config) — this is for
// sandbox testing convenience only.
export class AnthropicLLMClient implements LLMClient {
  constructor(private readonly apiKey: string, private readonly model: string = "claude-sonnet-4-5") {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    const textBlock = data.content.find((b: { type: string }) => b.type === "text");
    return textBlock?.text ?? "";
  }
}
