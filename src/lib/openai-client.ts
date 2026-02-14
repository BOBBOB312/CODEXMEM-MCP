import { loadSettings } from "./config.js";
import { logger } from "./logger.js";

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

export class OpenAIClient {
  private readonly chatApiKey: string;
  private readonly embeddingApiKey: string;
  private readonly chatBaseUrl: string;
  private readonly embeddingBaseUrl: string;
  private readonly chatModel: string;
  private readonly embeddingModel: string;

  constructor() {
    const settings = loadSettings();
    this.chatApiKey =
      process.env.OPENAI_API_KEY ||
      process.env.CODEXMEM_OPENAI_API_KEY ||
      settings.CODEXMEM_OPENAI_API_KEY ||
      "";
    this.chatBaseUrl =
      process.env.OPENAI_BASE_URL ||
      process.env.CODEXMEM_OPENAI_BASE_URL ||
      settings.CODEXMEM_OPENAI_BASE_URL ||
      "https://api.openai.com/v1";
    this.embeddingApiKey =
      process.env.CODEXMEM_OPENAI_EMBEDDING_API_KEY ||
      settings.CODEXMEM_OPENAI_EMBEDDING_API_KEY ||
      this.chatApiKey;
    this.embeddingBaseUrl =
      process.env.CODEXMEM_OPENAI_EMBEDDING_BASE_URL ||
      settings.CODEXMEM_OPENAI_EMBEDDING_BASE_URL ||
      this.chatBaseUrl;
    this.chatModel =
      process.env.CODEXMEM_OPENAI_MODEL ||
      settings.CODEXMEM_OPENAI_MODEL ||
      "gpt-4o-mini";
    this.embeddingModel =
      process.env.CODEXMEM_OPENAI_EMBEDDING_MODEL ||
      settings.CODEXMEM_OPENAI_EMBEDDING_MODEL ||
      "text-embedding-3-small";
  }

  isChatConfigured(): boolean {
    return !!this.chatApiKey;
  }

  isEmbeddingConfigured(): boolean {
    return !!this.embeddingApiKey;
  }

  async chatJson(systemPrompt: string, userPrompt: string): Promise<string | null> {
    if (!this.isChatConfigured()) return null;

    const url = `${this.chatBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.chatApiKey}`,
            "Content-Type": "application/json"
          },
          signal: withTimeout(15_000),
          body: JSON.stringify({
            model: this.chatModel,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          })
        });

        if (!response.ok) {
          const text = await response.text();
          if (response.status >= 500 || response.status === 429) {
            throw new Error(`retryable chat error ${response.status}: ${text.slice(0, 300)}`);
          }
          logger.warn("OPENAI", "non-retryable chat error", { status: response.status, body: text.slice(0, 300) });
          return null;
        }

        const data = (await response.json()) as ChatResponse;
        return data.choices?.[0]?.message?.content ?? null;
      } catch (error) {
        const retryable = attempt < maxAttempts;
        logger.warn("OPENAI", "chat attempt failed", { attempt, retryable, error: String(error) });
        if (!retryable) return null;
        await sleep(300 * attempt);
      }
    }

    return null;
  }

  async embedding(text: string): Promise<number[] | null> {
    if (!this.isEmbeddingConfigured()) return null;
    const clean = text.trim();
    if (!clean) return null;

    const url = `${this.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.embeddingApiKey}`,
            "Content-Type": "application/json"
          },
          signal: withTimeout(12_000),
          body: JSON.stringify({ model: this.embeddingModel, input: clean })
        });

        if (!response.ok) {
          const textBody = await response.text();
          if (response.status >= 500 || response.status === 429) {
            throw new Error(`retryable embedding error ${response.status}: ${textBody.slice(0, 300)}`);
          }
          logger.warn("OPENAI", "non-retryable embedding error", { status: response.status, body: textBody.slice(0, 300) });
          return null;
        }

        const data = (await response.json()) as EmbeddingResponse;
        const vector = data.data?.[0]?.embedding;
        return Array.isArray(vector) ? vector : null;
      } catch (error) {
        const retryable = attempt < maxAttempts;
        logger.warn("OPENAI", "embedding attempt failed", { attempt, retryable, error: String(error) });
        if (!retryable) return null;
        await sleep(300 * attempt);
      }
    }

    return null;
  }
}
