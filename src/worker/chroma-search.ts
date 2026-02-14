import { ChromaClient } from "chromadb";
import { loadSettings } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { OpenAIClient } from "../lib/openai-client.js";

type VectorKind = "observation" | "summary" | "prompt";

type ChromaHit = {
  kind: VectorKind;
  itemId: number;
  distance: number | null;
};

type VectorQueryResult = {
  observations: number[];
  summaries: number[];
  prompts: number[];
};

export class ChromaSearchService {
  private readonly client: OpenAIClient;
  private chroma: ChromaClient | null = null;
  private collectionName = "";
  private initialized = false;
  private initFailed = false;

  constructor() {
    this.client = new OpenAIClient();
  }

  isConfigured(): boolean {
    const settings = loadSettings();
    return !!settings.CODEXMEM_CHROMA_URL && !!settings.CODEXMEM_CHROMA_COLLECTION && this.client.isEmbeddingConfigured();
  }

  private async ensureCollection(): Promise<void> {
    if (this.initialized || this.initFailed) return;
    if (!this.isConfigured()) return;

    const settings = loadSettings();
    try {
      this.chroma = new ChromaClient({ path: settings.CODEXMEM_CHROMA_URL });
      this.collectionName = settings.CODEXMEM_CHROMA_COLLECTION || "codexmem_memory";
      await this.chroma.getOrCreateCollection({
        name: this.collectionName
      });
      this.initialized = true;
    } catch (error) {
      this.initFailed = true;
      logger.warn("CHROMA", "Failed to initialize chroma collection", { error: String(error) });
    }
  }

  private async upsert(kind: VectorKind, id: number, project: string, text: string, createdAtEpoch: number): Promise<void> {
    if (!text.trim()) return;
    await this.ensureCollection();
    if (!this.initialized || !this.chroma) return;

    const vector = await this.client.embedding(text);
    if (!vector) return;

    try {
      const collection = await this.chroma.getCollection({ name: this.collectionName });
      await collection.upsert({
        ids: [`${kind}:${id}`],
        embeddings: [vector],
        documents: [text],
        metadatas: [
          {
            kind,
            item_id: id,
            project,
            created_at_epoch: createdAtEpoch
          }
        ]
      });
    } catch (error) {
      logger.warn("CHROMA", "Failed to upsert vector document", { kind, id, error: String(error) });
    }
  }

  async indexObservation(id: number, project: string, text: string, createdAtEpoch: number): Promise<void> {
    await this.upsert("observation", id, project, text, createdAtEpoch);
  }

  async indexSummary(id: number, project: string, text: string, createdAtEpoch: number): Promise<void> {
    await this.upsert("summary", id, project, text, createdAtEpoch);
  }

  async indexPrompt(id: number, project: string, text: string, createdAtEpoch: number): Promise<void> {
    await this.upsert("prompt", id, project, text, createdAtEpoch);
  }

  async queryIds(query: string, project: string | undefined, limit: number): Promise<VectorQueryResult> {
    await this.ensureCollection();
    if (!this.initialized || !this.chroma) {
      return { observations: [], summaries: [], prompts: [] };
    }
    const q = query.trim();
    if (!q) return { observations: [], summaries: [], prompts: [] };

    const vector = await this.client.embedding(q);
    if (!vector) return { observations: [], summaries: [], prompts: [] };

    try {
      const collection = await this.chroma.getCollection({ name: this.collectionName });
      const where = project ? ({ project } as Record<string, string>) : undefined;
      const result = await collection.query({
        queryEmbeddings: [vector],
        nResults: Math.max(limit * 4, 20),
        where,
        include: ["metadatas", "distances"]
      });

      const hits: ChromaHit[] = [];
      const ids = result.ids?.[0] || [];
      const metadatas = result.metadatas?.[0] || [];
      const distances = result.distances?.[0] || [];

      for (let i = 0; i < ids.length; i++) {
        const meta = metadatas[i] as Record<string, unknown> | null;
        if (!meta) continue;
        const kind = String(meta.kind || "") as VectorKind;
        const itemId = Number(meta.item_id);
        if (!Number.isInteger(itemId)) continue;
        if (kind !== "observation" && kind !== "summary" && kind !== "prompt") continue;
        hits.push({
          kind,
          itemId,
          distance: typeof distances[i] === "number" ? distances[i] : null
        });
      }

      hits.sort((a, b) => {
        const da = a.distance ?? Number.POSITIVE_INFINITY;
        const db = b.distance ?? Number.POSITIVE_INFINITY;
        return da - db;
      });

      const observations: number[] = [];
      const summaries: number[] = [];
      const prompts: number[] = [];
      const seenObs = new Set<number>();
      const seenSum = new Set<number>();
      const seenPrompt = new Set<number>();

      for (const hit of hits) {
        if (hit.kind === "observation") {
          if (seenObs.has(hit.itemId)) continue;
          seenObs.add(hit.itemId);
          observations.push(hit.itemId);
        } else if (hit.kind === "summary") {
          if (seenSum.has(hit.itemId)) continue;
          seenSum.add(hit.itemId);
          summaries.push(hit.itemId);
        } else {
          if (seenPrompt.has(hit.itemId)) continue;
          seenPrompt.add(hit.itemId);
          prompts.push(hit.itemId);
        }
      }

      return {
        observations: observations.slice(0, limit),
        summaries: summaries.slice(0, limit),
        prompts: prompts.slice(0, limit)
      };
    } catch (error) {
      logger.warn("CHROMA", "Failed to query vector documents", { error: String(error) });
      return { observations: [], summaries: [], prompts: [] };
    }
  }
}
