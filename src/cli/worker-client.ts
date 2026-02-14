import { getWorkerPort } from "../lib/config.js";

export async function postWorker(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<Response> {
  const url = `http://127.0.0.1:${getWorkerPort()}${path}`;

  return await Promise.race([
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    new Promise<Response>((_, reject) => {
      setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    })
  ]) as Response;
}

export async function workerHealthy(): Promise<boolean> {
  const url = `http://127.0.0.1:${getWorkerPort()}/api/health`;
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
