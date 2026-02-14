import fs from "node:fs";

export function extractLastAssistantMessage(transcriptPath?: string): string {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return "";

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]) as any;
        if (row.role === "assistant" && typeof row.content === "string") {
          return row.content;
        }
      } catch {
        // ignore bad line
      }
    }
  } catch {
    return "";
  }

  return "";
}
