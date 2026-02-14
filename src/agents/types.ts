import type { ObservationInput, PendingMessage, SummaryInput } from "../types/models.js";

export interface MemoryAgent {
  readonly name: string;
  processObservation(message: PendingMessage): Promise<ObservationInput>;
  processSummary(message: PendingMessage): Promise<SummaryInput>;
}
