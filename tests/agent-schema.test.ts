import { describe, expect, test } from "bun:test";
import { validateObservationStrict, validateSummaryStrict } from "../src/agents/schema.js";

describe("agent schema validation", () => {
  test("valid observation passes strict validation", () => {
    const res = validateObservationStrict({
      type: "bugfix",
      title: "Fix auth bug",
      subtitle: null,
      facts: ["jwt expired"],
      narrative: "fixed token refresh flow",
      concepts: ["auth"],
      files_read: ["src/auth.ts"],
      files_modified: ["src/auth.ts"]
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.type).toBe("bugfix");
      expect(res.data.facts.length).toBe(1);
    }
  });

  test("invalid observation is rejected", () => {
    const res = validateObservationStrict({
      type: "unknown",
      title: 123,
      subtitle: null,
      facts: "bad",
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: []
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  test("valid summary passes strict validation", () => {
    const res = validateSummaryStrict({
      request: "do x",
      investigated: "read files",
      learned: "y",
      completed: "done",
      next_steps: "ship",
      notes: null
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.request).toBe("do x");
    }
  });

  test("invalid summary is rejected", () => {
    const res = validateSummaryStrict({
      request: "ok",
      investigated: "ok",
      learned: "ok",
      completed: "ok",
      next_steps: "ok",
      notes: 42
    });
    expect(res.ok).toBe(false);
  });
});
