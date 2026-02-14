import { OpenAIClient } from "../lib/openai-client.js";
import type { Store } from "../db/store.js";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class SemanticSearchService {
  private readonly client = new OpenAIClient();

  isAvailable(): boolean {
    return this.client.isEmbeddingConfigured();
  }

  async indexObservation(store: Store, observationId: number, project: string, payloadText: string): Promise<void> {
    if (!this.isAvailable()) return;
    const vector = await this.client.embedding(payloadText);
    if (!vector) return;
    store.saveObservationEmbedding(observationId, project, vector);
  }

  async findObservationIds(store: Store, query: string, project: string | undefined, limit: number): Promise<number[]> {
    if (!this.isAvailable()) return [];
    const qv = await this.client.embedding(query);
    if (!qv) return [];

    const rows = store.getObservationEmbeddings(project);
    const scored: Array<{ id: number; score: number }> = [];

    for (const row of rows) {
      try {
        const vector = JSON.parse(row.vector_json) as number[];
        if (!Array.isArray(vector)) continue;
        const score = cosineSimilarity(qv, vector);
        if (score > 0) {
          scored.push({ id: row.observation_id, score });
        }
      } catch {
        // ignore malformed vector rows
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.id);
  }
}
