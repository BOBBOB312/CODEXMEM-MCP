import type { ObservationInput, SummaryInput } from "../types/models.js";

const ALLOWED_OBS_TYPES = new Set(["discovery", "change", "execution", "decision", "bugfix"]);
const MAX_FACTS = 12;
const MAX_CONCEPTS = 10;
const MAX_FILES = 20;
const MAX_TITLE = 240;
const MAX_SUBTITLE = 240;
const MAX_NARRATIVE = 4000;
const MAX_SUMMARY_REQUEST = 1200;
const MAX_SUMMARY_BLOCK = 3000;
const MAX_SUMMARY_NOTES = 1200;

export type ValidationResult<T> =
  | { ok: true; data: T; errors: string[] }
  | { ok: false; errors: string[] };

function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function normalizeFilePath(value: string): string {
  const cleaned = sanitizeText(value, 600).replace(/\\/g, "/");
  // keep ASCII-ish paths to avoid noisy binary/control characters in memory index
  return cleaned.replace(/[^\x20-\x7E]/g, "");
}

function ensureStringArray(value: unknown, field: string, errors: string[], opts: { maxItems: number; maxItemLen: number; lower?: boolean; filePath?: boolean }): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field} contains non-string item`);
      continue;
    }
    let cleaned = opts.filePath ? normalizeFilePath(item) : sanitizeText(item, opts.maxItemLen);
    if (opts.lower) cleaned = cleaned.toLowerCase();
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= opts.maxItems) break;
  }
  return out;
}

export function validateObservationStrict(raw: unknown): ValidationResult<ObservationInput> {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["observation must be an object"] };
  }
  const obj = raw as Record<string, unknown>;
  const requiredKeys = ["type", "title", "subtitle", "facts", "narrative", "concepts", "files_read", "files_modified"];
  for (const key of requiredKeys) {
    if (!(key in obj)) errors.push(`missing key: ${key}`);
  }

  const type = typeof obj.type === "string" ? obj.type.toLowerCase().trim() : "";
  if (!ALLOWED_OBS_TYPES.has(type)) {
    errors.push(`type must be one of: ${Array.from(ALLOWED_OBS_TYPES).join(",")}`);
  }

  if (obj.title !== null && typeof obj.title !== "string") errors.push("title must be string|null");
  if (obj.subtitle !== null && typeof obj.subtitle !== "string") errors.push("subtitle must be string|null");
  if (obj.narrative !== null && typeof obj.narrative !== "string") errors.push("narrative must be string|null");

  const facts = ensureStringArray(obj.facts, "facts", errors, { maxItems: MAX_FACTS, maxItemLen: 200 });
  const concepts = ensureStringArray(obj.concepts, "concepts", errors, { maxItems: MAX_CONCEPTS, maxItemLen: 80, lower: true });
  const filesRead = ensureStringArray(obj.files_read, "files_read", errors, { maxItems: MAX_FILES, maxItemLen: 600, filePath: true });
  const filesModified = ensureStringArray(obj.files_modified, "files_modified", errors, { maxItems: MAX_FILES, maxItemLen: 600, filePath: true });

  const title = obj.title === null ? "" : sanitizeText(obj.title, MAX_TITLE);
  const subtitle = obj.subtitle === null ? null : sanitizeText(obj.subtitle, MAX_SUBTITLE) || null;
  const narrative = obj.narrative === null ? "" : sanitizeText(obj.narrative, MAX_NARRATIVE);

  if (!title) errors.push("title must not be empty");
  if (!narrative) errors.push("narrative must not be empty");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      type,
      title,
      subtitle,
      facts: facts.slice(0, MAX_FACTS),
      narrative,
      concepts,
      files_read: filesRead.slice(0, MAX_FILES),
      files_modified: filesModified.slice(0, MAX_FILES)
    },
    errors: []
  };
}

export function validateSummaryStrict(raw: unknown): ValidationResult<SummaryInput> {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["summary must be an object"] };
  const obj = raw as Record<string, unknown>;
  const requiredKeys = ["request", "investigated", "learned", "completed", "next_steps", "notes"];
  for (const key of requiredKeys) {
    if (!(key in obj)) errors.push(`missing key: ${key}`);
  }

  for (const field of ["request", "investigated", "learned", "completed", "next_steps"] as const) {
    if (typeof obj[field] !== "string") errors.push(`${field} must be string`);
  }
  if (obj.notes !== null && typeof obj.notes !== "string") errors.push("notes must be string|null");
  if (errors.length > 0) return { ok: false, errors };

  const data: SummaryInput = {
    request: sanitizeText(obj.request, MAX_SUMMARY_REQUEST),
    investigated: sanitizeText(obj.investigated, MAX_SUMMARY_BLOCK),
    learned: sanitizeText(obj.learned, MAX_SUMMARY_BLOCK),
    completed: sanitizeText(obj.completed, MAX_SUMMARY_BLOCK),
    next_steps: sanitizeText(obj.next_steps, MAX_SUMMARY_BLOCK),
    notes: obj.notes === null ? null : sanitizeText(obj.notes, MAX_SUMMARY_NOTES)
  };

  for (const field of ["request", "investigated", "learned", "completed", "next_steps"] as const) {
    if (!data[field]) errors.push(`${field} must not be empty`);
  }
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, data, errors: [] };
}
