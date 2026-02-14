import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db/store.js";

const cleanupDirs: string[] = [];

function createStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexmem-search-"));
  cleanupDirs.push(dir);
  return new Store(path.join(dir, "test.db"));
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure in temp dirs
    }
  }
});

describe("search filters", () => {
  test("supports obsTypes and date range filters", () => {
    const store = createStore();
    const sid = store.createSDKSession("sess-f1", "proj-a", "prompt");
    const mid = `cmem-${sid}`;
    store.ensureMemorySessionIdRegistered(sid, mid);

    const oldEpoch = Date.now() - 5 * 24 * 3600 * 1000;
    const recentEpoch = Date.now() - 1 * 24 * 3600 * 1000;

    const id1 = store.storeObservation(mid, "proj-a", {
      type: "bugfix",
      title: "bug fixed",
      subtitle: null,
      facts: [],
      narrative: "auth fix",
      concepts: [],
      files_read: [],
      files_modified: []
    }, 1);
    const id2 = store.storeObservation(mid, "proj-a", {
      type: "decision",
      title: "design choice",
      subtitle: null,
      facts: [],
      narrative: "decide to keep api",
      concepts: [],
      files_read: [],
      files_modified: []
    }, 1);

    store.db.query("UPDATE observations SET created_at_epoch = ? WHERE id = ?").run(oldEpoch, id1);
    store.db.query("UPDATE observations SET created_at_epoch = ? WHERE id = ?").run(recentEpoch, id2);

    const result = store.search({
      query: "",
      project: "proj-a",
      obsTypes: ["decision"],
      dateStartEpoch: recentEpoch - 1000,
      dateEndEpoch: recentEpoch + 1000
    });

    expect(result.observations.length).toBe(1);
    expect(result.observations[0].id).toBe(id2);
    expect(result.observations[0].type).toBe("decision");
    store.close();
  });

  test("supports kind-only search toggles", () => {
    const store = createStore();
    const sid = store.createSDKSession("sess-f2", "proj-b", "prompt");
    const mid = `cmem-${sid}`;
    store.ensureMemorySessionIdRegistered(sid, mid);
    store.saveUserPrompt("sess-f2", 1, "hello prompt");
    store.storeSummary(mid, "proj-b", {
      request: "req",
      investigated: "inv",
      learned: "learn",
      completed: "done",
      next_steps: "next",
      notes: null
    }, 1);
    store.storeObservation(mid, "proj-b", {
      type: "execution",
      title: "ran tests",
      subtitle: null,
      facts: [],
      narrative: "test done",
      concepts: [],
      files_read: [],
      files_modified: []
    }, 1);

    const promptsOnly = store.search({
      query: "",
      project: "proj-b",
      includeObservations: false,
      includeSessions: false,
      includePrompts: true
    });

    expect(promptsOnly.observations.length).toBe(0);
    expect(promptsOnly.sessions.length).toBe(0);
    expect(promptsOnly.prompts.length).toBe(1);
    store.close();
  });
});
