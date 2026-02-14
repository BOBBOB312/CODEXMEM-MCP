import { getPlatformAdapter } from "./adapters/index.js";
import { getEventHandler } from "./handlers/index.js";
import { readJsonFromStdin } from "./stdin-reader.js";

function isWorkerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const patterns = [
    "econnrefused",
    "econnreset",
    "epipe",
    "etimedout",
    "fetch failed",
    "timeout",
    "timed out"
  ];
  return patterns.some((p) => lower.includes(p));
}

export async function hookCommand(platform: string, event: string): Promise<number> {
  try {
    const adapter = getPlatformAdapter(platform);
    const handler = getEventHandler(event);

    const rawInput = await readJsonFromStdin();
    const normalized = adapter.normalizeInput(rawInput);
    normalized.platform = platform;

    const result = await handler.execute(normalized);
    const output = adapter.formatOutput(result);
    console.log(JSON.stringify(output));
    return result.exitCode ?? 0;
  } catch (error) {
    if (isWorkerUnavailableError(error)) {
      console.error(`[codexmem] worker unavailable, skip hook: ${String(error)}`);
      return 0;
    }

    console.error(`[codexmem] hook error: ${String(error)}`);
    return 2;
  }
}
