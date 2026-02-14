import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";

function newStore(): { store: Store; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-test-"));
  const dbPath = path.join(dir, "test.db");
  return { store: new Store(dbPath), dbPath };
}

function setupSession(store: Store, contentSessionId: string, project = "test-project"): { sessionDbId: number; memorySessionId: string } {
  const sessionDbId = store.createSDKSession(contentSessionId, project, "test prompt");
  const memorySessionId = `cmem-${sessionDbId}`;
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
  return { sessionDbId, memorySessionId };
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const dbPath of cleanupPaths.splice(0, cleanupPaths.length)) {
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in temp folders
    }
  }
});

describe("queue recovery", () => {
  test("duplicate observation enqueue is idempotent by dedupe key", () => {
    const { store, dbPath } = newStore();
    cleanupPaths.push(dbPath);
    const { sessionDbId } = setupSession(store, "sess-dedupe-1");

    const first = store.enqueueObservation(sessionDbId, "sess-dedupe-1", {
      tool_name: "Read",
      tool_input: "{\"file\":\"a.ts\"}",
      tool_response: "{\"ok\":true}",
      cwd: "/tmp",
      prompt_number: 1,
      dedupe_key: "obs-key-1"
    });
    const second = store.enqueueObservation(sessionDbId, "sess-dedupe-1", {
      tool_name: "Read",
      tool_input: "{\"file\":\"a.ts\"}",
      tool_response: "{\"ok\":true}",
      cwd: "/tmp",
      prompt_number: 1,
      dedupe_key: "obs-key-1"
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(store.getPendingCount(sessionDbId)).toBe(1);

    store.close();
  });

  test("claim -> store -> confirm keeps one observation and clears queue", () => {
    const { store, dbPath } = newStore();
    cleanupPaths.push(dbPath);
    const { sessionDbId, memorySessionId } = setupSession(store, "sess-c1");

    store.enqueueObservation(sessionDbId, "sess-c1", {
      tool_name: "Read",
      tool_input: "{\"file\":\"a.ts\"}",
      tool_response: "{\"ok\":true}",
      cwd: "/tmp",
      prompt_number: 1
    });

    const msg = store.claimNextPending(sessionDbId);
    expect(msg).not.toBeNull();

    const obsId = store.storeObservation(memorySessionId, "test-project", {
      type: "execution",
      title: "stored",
      subtitle: null,
      facts: ["f1"],
      narrative: "n1",
      concepts: ["c1"],
      files_read: ["a.ts"],
      files_modified: []
    }, 1);

    store.confirmProcessed(msg!.id);
    expect(store.getPendingCount(sessionDbId)).toBe(0);
    expect(store.getObservationById(obsId)).not.toBeNull();

    store.close();
  });

  test("stale processing message can be reset and consumed again", () => {
    const { store, dbPath } = newStore();
    cleanupPaths.push(dbPath);
    const { sessionDbId, memorySessionId } = setupSession(store, "sess-c2");

    store.enqueueObservation(sessionDbId, "sess-c2", {
      tool_name: "Edit",
      tool_input: "{\"file\":\"b.ts\"}",
      tool_response: "{\"ok\":true}",
      cwd: "/tmp",
      prompt_number: 1
    });

    const firstClaim = store.claimNextPending(sessionDbId);
    expect(firstClaim).not.toBeNull();

    store.db
      .query("UPDATE pending_messages SET started_processing_at_epoch = ? WHERE id = ?")
      .run(Date.now() - 10_000, firstClaim!.id);

    const resetCount = store.resetStaleProcessing(1_000);
    expect(resetCount).toBe(1);

    const secondClaim = store.claimNextPending(sessionDbId);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim!.id).toBe(firstClaim!.id);

    store.storeObservation(memorySessionId, "test-project", {
      type: "change",
      title: "recovered",
      subtitle: null,
      facts: [],
      narrative: "replayed after stale reset",
      concepts: [],
      files_read: [],
      files_modified: ["b.ts"]
    }, 1);
    store.confirmProcessed(secondClaim!.id);

    expect(store.getPendingCount(sessionDbId)).toBe(0);
    const count = (store.db.query("SELECT COUNT(*) AS c FROM observations").get() as { c: number }).c;
    expect(count).toBe(1);

    store.close();
  });

  test("failed retry reaches capped failed status", () => {
    const { store, dbPath } = newStore();
    cleanupPaths.push(dbPath);
    const { sessionDbId } = setupSession(store, "sess-c3");

    store.enqueueObservation(sessionDbId, "sess-c3", {
      tool_name: "Run",
      tool_input: "{}",
      tool_response: "{}",
      cwd: "/tmp",
      prompt_number: 1
    });

    for (let i = 0; i < 4; i++) {
      const msg = store.claimNextPending(sessionDbId);
      expect(msg).not.toBeNull();
      store.markFailed(msg!.id);
    }

    const row = store.db
      .query("SELECT status, retry_count FROM pending_messages LIMIT 1")
      .get() as { status: string; retry_count: number } | null;

    expect(row).not.toBeNull();
    expect(row!.status).toBe("failed");
    expect(row!.retry_count).toBe(3);
    expect(store.claimNextPending(sessionDbId)).toBeNull();

    store.close();
  });
});
