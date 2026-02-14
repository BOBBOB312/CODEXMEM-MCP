export async function readJsonFromStdin(): Promise<unknown> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
