import { Database } from "bun:sqlite";
import path from "node:path";
import { DB_PATH, ensureDataDir } from "../lib/config.js";
import type { ObservationInput, PendingMessage, SummaryInput } from "../types/models.js";

const MAX_RETRY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionPolicyInput = {
  enabled?: boolean;
  pinned?: boolean;
  ttlDays?: number | null;
};

export type RetentionCleanupOptions = {
  dryRun: boolean;
  nowEpoch?: number;
  defaultTtlDays: number;
  softDeleteDays: number;
};

export type RetentionCleanupReport = {
  dryRun: boolean;
  nowEpoch: number;
  defaultTtlDays: number;
  softDeleteDays: number;
  scannedProjects: number;
  skippedPinned: number;
  skippedDisabled: number;
  softDeleted: { projects: number; observations: number; summaries: number; prompts: number };
  hardDeleted: { observations: number; summaries: number; prompts: number };
  details: Array<{
    project: string;
    ttlDays: number;
    lastAccessEpoch: number | null;
    inactiveDays: number | null;
    skippedReason?: "pinned" | "disabled" | "not_expired";
    softDeleteCandidate: boolean;
    counts: { observations: number; summaries: number; prompts: number };
  }>;
};

export class Store {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    ensureDataDir();
    this.db = new Database(dbPath, { create: true, readwrite: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL CHECK(status IN ('active','completed','failed'))
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_content ON sdk_sessions(content_session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_memory ON sdk_sessions(memory_session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(content_session_id, prompt_number)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        discovery_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_created ON session_summaries(created_at_epoch DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_project ON session_summaries(project)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation','summarize')),
        dedupe_key TEXT,
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','processed','failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        failed_at_epoch INTEGER,
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_messages(session_db_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_messages(status)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_content_session ON pending_messages(content_session_id)");
    this.ensurePendingMessageDedupeSchema();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS processed_message_dedupe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation','summarize')),
        dedupe_key TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        UNIQUE(session_db_id, message_type, dedupe_key),
        FOREIGN KEY(session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_processed_dedupe_session ON processed_message_dedupe(session_db_id)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS observation_embeddings (
        observation_id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_obs_embeddings_project ON observation_embeddings(project)");
    this.ensureMemoryRetentionSchema();
  }

  private ensurePendingMessageDedupeSchema(): void {
    const columns = this.db.query("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>;
    const hasDedupeKey = columns.some((c) => c.name === "dedupe_key");
    if (!hasDedupeKey) {
      this.db.run("ALTER TABLE pending_messages ADD COLUMN dedupe_key TEXT");
    }

    this.db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_dedupe ON pending_messages(session_db_id, message_type, dedupe_key) WHERE dedupe_key IS NOT NULL"
    );
  }

  private ensureColumn(table: string, column: string, definitionSql: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) return;
    this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definitionSql}`);
  }

  private ensureMemoryRetentionSchema(): void {
    this.ensureColumn("observations", "last_accessed_at_epoch", "INTEGER");
    this.ensureColumn("observations", "deleted_at_epoch", "INTEGER");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_deleted ON observations(deleted_at_epoch)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_last_access ON observations(last_accessed_at_epoch)");

    this.ensureColumn("session_summaries", "last_accessed_at_epoch", "INTEGER");
    this.ensureColumn("session_summaries", "deleted_at_epoch", "INTEGER");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_deleted ON session_summaries(deleted_at_epoch)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_summaries_last_access ON session_summaries(last_accessed_at_epoch)");

    this.ensureColumn("user_prompts", "last_accessed_at_epoch", "INTEGER");
    this.ensureColumn("user_prompts", "deleted_at_epoch", "INTEGER");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_prompts_deleted ON user_prompts(deleted_at_epoch)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_prompts_last_access ON user_prompts(last_accessed_at_epoch)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS project_memory_activity (
        project TEXT PRIMARY KEY,
        last_accessed_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS project_retention_policies (
        project TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        ttl_days INTEGER,
        updated_at_epoch INTEGER NOT NULL
      );
    `);
  }

  createSDKSession(contentSessionId: string, project: string, userPrompt: string): number {
    const existing = this.db
      .query("SELECT id FROM sdk_sessions WHERE content_session_id = ?")
      .get(contentSessionId) as { id: number } | null;

    if (existing) {
      if (project) {
        this.db
          .query("UPDATE sdk_sessions SET project = ? WHERE content_session_id = ? AND (project IS NULL OR project = \"\")")
          .run(project, contentSessionId);
      }
      return existing.id;
    }

    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    this.db
      .query(
        `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status)
         VALUES (?, NULL, ?, ?, ?, ?, 'active')`
      )
      .run(contentSessionId, project, userPrompt, nowIso, nowEpoch);
    this.touchProjectActivity([project], nowEpoch);

    const row = this.db
      .query("SELECT id FROM sdk_sessions WHERE content_session_id = ?")
      .get(contentSessionId) as { id: number };
    return row.id;
  }

  ensureMemorySessionIdRegistered(sessionDbId: number, memorySessionId: string): void {
    this.db.query("UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?").run(memorySessionId, sessionDbId);
  }

  getSessionById(sessionDbId: number): { id: number; content_session_id: string; memory_session_id: string | null; project: string; user_prompt: string | null } | null {
    return this.db
      .query("SELECT id, content_session_id, memory_session_id, project, user_prompt FROM sdk_sessions WHERE id = ?")
      .get(sessionDbId) as any;
  }

  getSessionByContentSessionId(contentSessionId: string): { id: number; content_session_id: string; memory_session_id: string | null; project: string; user_prompt: string | null } | null {
    return this.db
      .query("SELECT id, content_session_id, memory_session_id, project, user_prompt FROM sdk_sessions WHERE content_session_id = ?")
      .get(contentSessionId) as any;
  }

  saveUserPrompt(contentSessionId: string, promptNumber: number, promptText: string): number {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    const result = this.db
      .query(
        `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, last_accessed_at_epoch, deleted_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(contentSessionId, promptNumber, promptText, nowIso, nowEpoch, nowEpoch);
    const row = this.db
      .query("SELECT project FROM sdk_sessions WHERE content_session_id = ?")
      .get(contentSessionId) as { project?: string } | null;
    if (row?.project) this.touchProjectActivity([row.project], nowEpoch);
    return Number(result.lastInsertRowid);
  }

  getPromptNumberFromUserPrompts(contentSessionId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM user_prompts WHERE content_session_id = ?")
      .get(contentSessionId) as { count: number };
    return row.count;
  }

  getUserPrompt(contentSessionId: string, promptNumber: number): string | null {
    const row = this.db
      .query("SELECT prompt_text FROM user_prompts WHERE content_session_id = ? AND prompt_number = ? LIMIT 1")
      .get(contentSessionId, promptNumber) as { prompt_text: string } | null;
    return row?.prompt_text ?? null;
  }

  enqueueObservation(
    sessionDbId: number,
    contentSessionId: string,
    payload: { tool_name: string; tool_input: string; tool_response: string; cwd: string; prompt_number: number; dedupe_key?: string }
  ): { id: number; deduped: boolean } {
    const now = Date.now();
    if (!payload.dedupe_key) {
      const result = this.db
        .query(
          `INSERT INTO pending_messages
           (session_db_id, content_session_id, message_type, dedupe_key, tool_name, tool_input, tool_response, cwd, prompt_number, status, retry_count, created_at_epoch)
           VALUES (?, ?, 'observation', NULL, ?, ?, ?, ?, ?, 'pending', 0, ?)`
        )
        .run(sessionDbId, contentSessionId, payload.tool_name, payload.tool_input, payload.tool_response, payload.cwd, payload.prompt_number, now);
      return { id: Number(result.lastInsertRowid), deduped: false };
    }

    const tx = this.db.transaction(() => {
      const dedupeInsert = this.db
        .query(
          `INSERT OR IGNORE INTO processed_message_dedupe
           (session_db_id, message_type, dedupe_key, created_at_epoch)
           VALUES (?, 'observation', ?, ?)`
        )
        .run(sessionDbId, payload.dedupe_key as string, now);

      if (dedupeInsert.changes === 0) {
        const existing = this.db
          .query("SELECT id FROM pending_messages WHERE session_db_id = ? AND message_type = 'observation' AND dedupe_key = ? LIMIT 1")
          .get(sessionDbId, payload.dedupe_key as string) as { id: number } | null;
        return { id: existing?.id ?? 0, deduped: true };
      }

      const insertResult = this.db
        .query(
          `INSERT INTO pending_messages
           (session_db_id, content_session_id, message_type, dedupe_key, tool_name, tool_input, tool_response, cwd, prompt_number, status, retry_count, created_at_epoch)
           VALUES (?, ?, 'observation', ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
        )
        .run(
          sessionDbId,
          contentSessionId,
          payload.dedupe_key as string,
          payload.tool_name,
          payload.tool_input,
          payload.tool_response,
          payload.cwd,
          payload.prompt_number,
          now
        );

      return { id: Number(insertResult.lastInsertRowid), deduped: false };
    });

    return tx() as { id: number; deduped: boolean };
  }

  enqueueSummarize(
    sessionDbId: number,
    contentSessionId: string,
    payload: { last_assistant_message: string; prompt_number: number; dedupe_key?: string }
  ): { id: number; deduped: boolean } {
    const now = Date.now();
    if (!payload.dedupe_key) {
      const result = this.db
        .query(
          `INSERT INTO pending_messages
           (session_db_id, content_session_id, message_type, dedupe_key, last_assistant_message, prompt_number, status, retry_count, created_at_epoch)
           VALUES (?, ?, 'summarize', NULL, ?, ?, 'pending', 0, ?)`
        )
        .run(sessionDbId, contentSessionId, payload.last_assistant_message, payload.prompt_number, now);
      return { id: Number(result.lastInsertRowid), deduped: false };
    }

    const tx = this.db.transaction(() => {
      const dedupeInsert = this.db
        .query(
          `INSERT OR IGNORE INTO processed_message_dedupe
           (session_db_id, message_type, dedupe_key, created_at_epoch)
           VALUES (?, 'summarize', ?, ?)`
        )
        .run(sessionDbId, payload.dedupe_key as string, now);

      if (dedupeInsert.changes === 0) {
        const existing = this.db
          .query("SELECT id FROM pending_messages WHERE session_db_id = ? AND message_type = 'summarize' AND dedupe_key = ? LIMIT 1")
          .get(sessionDbId, payload.dedupe_key as string) as { id: number } | null;
        return { id: existing?.id ?? 0, deduped: true };
      }

      const insertResult = this.db
        .query(
          `INSERT INTO pending_messages
           (session_db_id, content_session_id, message_type, dedupe_key, last_assistant_message, prompt_number, status, retry_count, created_at_epoch)
           VALUES (?, ?, 'summarize', ?, ?, ?, 'pending', 0, ?)`
        )
        .run(sessionDbId, contentSessionId, payload.dedupe_key as string, payload.last_assistant_message, payload.prompt_number, now);
      return { id: Number(insertResult.lastInsertRowid), deduped: false };
    });

    return tx() as { id: number; deduped: boolean };
  }

  claimNextPending(sessionDbId: number): PendingMessage | null {
    const tx = this.db.transaction((sid: number) => {
      const msg = this.db
        .query(
          `SELECT * FROM pending_messages
           WHERE session_db_id = ? AND status = 'pending'
           ORDER BY id ASC LIMIT 1`
        )
        .get(sid) as PendingMessage | null;

      if (!msg) return null;

      this.db
        .query("UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?")
        .run(Date.now(), msg.id);

      return msg;
    });

    return tx(sessionDbId) as PendingMessage | null;
  }

  confirmProcessed(messageId: number): void {
    this.db.query("DELETE FROM pending_messages WHERE id = ?").run(messageId);
  }

  markFailed(messageId: number): void {
    const row = this.db.query("SELECT retry_count FROM pending_messages WHERE id = ?").get(messageId) as { retry_count: number } | null;
    if (!row) return;

    if (row.retry_count < MAX_RETRY) {
      this.db
        .query("UPDATE pending_messages SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL WHERE id = ?")
        .run(messageId);
      return;
    }

    this.db
      .query("UPDATE pending_messages SET status = 'failed', failed_at_epoch = ? WHERE id = ?")
      .run(Date.now(), messageId);
  }

  resetStaleProcessing(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db
      .query(
        "UPDATE pending_messages SET status = 'pending', started_processing_at_epoch = NULL WHERE status = 'processing' AND started_processing_at_epoch < ?"
      )
      .run(cutoff);
    return result.changes;
  }

  getSessionsWithPendingMessages(): number[] {
    return (this.db
      .query("SELECT DISTINCT session_db_id FROM pending_messages WHERE status IN ('pending','processing')")
      .all() as Array<{ session_db_id: number }>).map((r) => r.session_db_id);
  }

  getPendingCount(sessionDbId: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM pending_messages WHERE session_db_id = ? AND status IN ('pending','processing')")
      .get(sessionDbId) as { count: number };
    return row.count;
  }

  getQueueCounts(): { pending: number; processing: number; failed: number } {
    const row = this.db
      .query(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM pending_messages`
      )
      .get() as { pending: number | null; processing: number | null; failed: number | null };

    return {
      pending: row.pending ?? 0,
      processing: row.processing ?? 0,
      failed: row.failed ?? 0
    };
  }

  retryFailed(sessionDbId?: number): number {
    if (typeof sessionDbId === "number") {
      const result = this.db
        .query(
          "UPDATE pending_messages SET status = 'pending', retry_count = 0, started_processing_at_epoch = NULL, failed_at_epoch = NULL WHERE status = 'failed' AND session_db_id = ?"
        )
        .run(sessionDbId);
      return result.changes;
    }

    const result = this.db
      .query(
        "UPDATE pending_messages SET status = 'pending', retry_count = 0, started_processing_at_epoch = NULL, failed_at_epoch = NULL WHERE status = 'failed'"
      )
      .run();
    return result.changes;
  }

  storeObservation(memorySessionId: string, project: string, observation: ObservationInput, promptNumber: number): number {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    const result = this.db
      .query(
        `INSERT INTO observations
         (memory_session_id, project, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch, last_accessed_at_epoch, deleted_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        memorySessionId,
        project,
        observation.type,
        observation.title,
        observation.subtitle,
        JSON.stringify(observation.facts),
        observation.narrative,
        JSON.stringify(observation.concepts),
        JSON.stringify(observation.files_read),
        JSON.stringify(observation.files_modified),
        promptNumber,
        nowIso,
        nowEpoch,
        nowEpoch
      );
    this.touchProjectActivity([project], nowEpoch);
    return Number(result.lastInsertRowid);
  }

  storeSummary(memorySessionId: string, project: string, summary: SummaryInput, promptNumber: number): number {
    const nowEpoch = Date.now();
    const nowIso = new Date(nowEpoch).toISOString();
    const result = this.db
      .query(
        `INSERT INTO session_summaries
         (memory_session_id, project, request, investigated, learned, completed, next_steps, notes, prompt_number, created_at, created_at_epoch, last_accessed_at_epoch, deleted_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        memorySessionId,
        project,
        summary.request,
        summary.investigated,
        summary.learned,
        summary.completed,
        summary.next_steps,
        summary.notes,
        promptNumber,
        nowIso,
        nowEpoch,
        nowEpoch
      );
    this.touchProjectActivity([project], nowEpoch);
    return Number(result.lastInsertRowid);
  }

  getObservationById(id: number): any | null {
    return this.db.query("SELECT * FROM observations WHERE id = ? AND deleted_at_epoch IS NULL").get(id) as any;
  }

  getObservationsByIds(
    ids: number[],
    options: {
      orderBy?: "date_desc" | "date_asc";
      limit?: number;
      project?: string;
      obsTypes?: string[];
      dateStartEpoch?: number;
      dateEndEpoch?: number;
    } = {}
  ): any[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const args: any[] = [...ids];
    const whereParts = [`id IN (${placeholders})`, "deleted_at_epoch IS NULL"];

    if (options.project) {
      whereParts.push("project = ?");
      args.push(options.project);
    }
    if (options.obsTypes && options.obsTypes.length > 0) {
      const placeholdersTypes = options.obsTypes.map(() => "?").join(",");
      whereParts.push(`type IN (${placeholdersTypes})`);
      args.push(...options.obsTypes);
    }
    if (typeof options.dateStartEpoch === "number") {
      whereParts.push("created_at_epoch >= ?");
      args.push(options.dateStartEpoch);
    }
    if (typeof options.dateEndEpoch === "number") {
      whereParts.push("created_at_epoch <= ?");
      args.push(options.dateEndEpoch);
    }

    const orderClause = options.orderBy === "date_asc" ? "ASC" : "DESC";
    const limitClause = options.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
    const sql = `SELECT * FROM observations WHERE ${whereParts.join(" AND ")} ORDER BY created_at_epoch ${orderClause} ${limitClause}`;
    return this.db.query(sql).all(...args) as any[];
  }

  listObservations(offset: number, limit: number, project?: string): { items: any[]; total: number } {
    const args: any[] = [];
    const where = project ? "WHERE project = ? AND deleted_at_epoch IS NULL" : "WHERE deleted_at_epoch IS NULL";
    if (project) args.push(project);

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM observations ${where}`)
      .get(...args) as { count: number };

    const rows = this.db
      .query(`SELECT * FROM observations ${where} ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as any[];

    return { items: rows, total: totalRow.count };
  }

  listSummaries(offset: number, limit: number, project?: string): { items: any[]; total: number } {
    const args: any[] = [];
    const where = project ? "WHERE project = ? AND deleted_at_epoch IS NULL" : "WHERE deleted_at_epoch IS NULL";
    if (project) args.push(project);

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM session_summaries ${where}`)
      .get(...args) as { count: number };

    const rows = this.db
      .query(`SELECT * FROM session_summaries ${where} ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as any[];

    return { items: rows, total: totalRow.count };
  }

  listPrompts(offset: number, limit: number, project?: string): { items: any[]; total: number } {
    const args: any[] = [];
    const where = project
      ? "WHERE up.deleted_at_epoch IS NULL AND up.content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)"
      : "WHERE up.deleted_at_epoch IS NULL";
    if (project) args.push(project);

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM user_prompts up ${where}`)
      .get(...args) as { count: number };

    const rows = this.db
      .query(`SELECT up.* FROM user_prompts up ${where} ORDER BY up.created_at_epoch DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as any[];

    return { items: rows, total: totalRow.count };
  }

  getSummariesByIds(
    ids: number[],
    options: { orderBy?: "date_desc" | "date_asc"; limit?: number; project?: string; dateStartEpoch?: number; dateEndEpoch?: number } = {}
  ): any[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const args: any[] = [...ids];
    const whereParts = [`id IN (${placeholders})`, "deleted_at_epoch IS NULL"];
    if (options.project) {
      whereParts.push("project = ?");
      args.push(options.project);
    }
    if (typeof options.dateStartEpoch === "number") {
      whereParts.push("created_at_epoch >= ?");
      args.push(options.dateStartEpoch);
    }
    if (typeof options.dateEndEpoch === "number") {
      whereParts.push("created_at_epoch <= ?");
      args.push(options.dateEndEpoch);
    }

    const orderClause = options.orderBy === "date_asc" ? "ASC" : "DESC";
    const limitClause = options.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
    return this.db
      .query(`SELECT * FROM session_summaries WHERE ${whereParts.join(" AND ")} ORDER BY created_at_epoch ${orderClause} ${limitClause}`)
      .all(...args) as any[];
  }

  getPromptsByIds(
    ids: number[],
    options: { orderBy?: "date_desc" | "date_asc"; limit?: number; project?: string; dateStartEpoch?: number; dateEndEpoch?: number } = {}
  ): any[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const args: any[] = [...ids];
    const whereParts = [`up.id IN (${placeholders})`, "up.deleted_at_epoch IS NULL"];
    if (options.project) {
      whereParts.push("s.project = ?");
      args.push(options.project);
    }
    if (typeof options.dateStartEpoch === "number") {
      whereParts.push("up.created_at_epoch >= ?");
      args.push(options.dateStartEpoch);
    }
    if (typeof options.dateEndEpoch === "number") {
      whereParts.push("up.created_at_epoch <= ?");
      args.push(options.dateEndEpoch);
    }

    const orderClause = options.orderBy === "date_asc" ? "ASC" : "DESC";
    const limitClause = options.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
    return this.db
      .query(
        `SELECT up.* FROM user_prompts up
         JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
         WHERE ${whereParts.join(" AND ")}
         ORDER BY up.created_at_epoch ${orderClause} ${limitClause}`
      )
      .all(...args) as any[];
  }

  listProjects(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT project FROM sdk_sessions WHERE project IS NOT NULL AND project <> '' ORDER BY project ASC")
      .all() as Array<{ project: string }>;
    return rows.map((r) => r.project);
  }

  saveObservationEmbedding(observationId: number, project: string, vector: number[]): void {
    this.db
      .query(
        `INSERT INTO observation_embeddings (observation_id, project, vector_json, created_at_epoch)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(observation_id) DO UPDATE SET
           project = excluded.project,
           vector_json = excluded.vector_json,
           created_at_epoch = excluded.created_at_epoch`
      )
      .run(observationId, project, JSON.stringify(vector), Date.now());
  }

  getObservationEmbeddings(project?: string): Array<{ observation_id: number; project: string; vector_json: string }> {
    if (project) {
      return this.db
        .query(
          `SELECT oe.observation_id, oe.project, oe.vector_json
           FROM observation_embeddings oe
           JOIN observations o ON o.id = oe.observation_id
           WHERE oe.project = ? AND o.deleted_at_epoch IS NULL`
        )
        .all(project) as Array<{ observation_id: number; project: string; vector_json: string }>;
    }
    return this.db
      .query(
        `SELECT oe.observation_id, oe.project, oe.vector_json
         FROM observation_embeddings oe
         JOIN observations o ON o.id = oe.observation_id
         WHERE o.deleted_at_epoch IS NULL`
      )
      .all() as Array<{ observation_id: number; project: string; vector_json: string }>;
  }

  getStats(): { observations: number; sessions: number; summaries: number; prompts: number; dbPath: string } {
    const observations = (this.db.query("SELECT COUNT(*) AS count FROM observations WHERE deleted_at_epoch IS NULL").get() as { count: number }).count;
    const sessions = (this.db.query("SELECT COUNT(*) AS count FROM sdk_sessions").get() as { count: number }).count;
    const summaries = (this.db.query("SELECT COUNT(*) AS count FROM session_summaries WHERE deleted_at_epoch IS NULL").get() as { count: number }).count;
    const prompts = (this.db.query("SELECT COUNT(*) AS count FROM user_prompts WHERE deleted_at_epoch IS NULL").get() as { count: number }).count;

    return {
      observations,
      sessions,
      summaries,
      prompts,
      dbPath: path.resolve(DB_PATH)
    };
  }

  getOrCreateManualSession(project: string): string {
    const contentSessionId = `manual-${project}`;
    const sessionId = this.createSDKSession(contentSessionId, project, "Manual memory session");
    const memorySessionId = `manual-${sessionId}`;
    this.ensureMemorySessionIdRegistered(sessionId, memorySessionId);
    return memorySessionId;
  }

  search(args: {
    query?: string;
    limit?: number;
    offset?: number;
    project?: string;
    includeObservations?: boolean;
    includeSessions?: boolean;
    includePrompts?: boolean;
    obsTypes?: string[];
    dateStartEpoch?: number;
    dateEndEpoch?: number;
    orderBy?: "relevance" | "date_desc" | "date_asc";
  }): { observations: any[]; sessions: any[]; prompts: any[] } {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
    const offset = Math.max(0, args.offset ?? 0);
    const q = (args.query || "").trim();

    const orderBy = args.orderBy === "date_asc" ? "ASC" : "DESC";
    const includeObservations = args.includeObservations !== false;
    const includeSessions = args.includeSessions !== false;
    const includePrompts = args.includePrompts !== false;

    const like = `%${q}%`;

    const observations = includeObservations
      ? (() => {
          const where: string[] = ["1=1"];
          where.push("deleted_at_epoch IS NULL");
          const values: any[] = [];
          if (q) {
            where.push("(title LIKE ? OR subtitle LIKE ? OR narrative LIKE ?)");
            values.push(like, like, like);
          }
          if (args.project) {
            where.push("project = ?");
            values.push(args.project);
          }
          if (args.obsTypes && args.obsTypes.length > 0) {
            where.push(`type IN (${args.obsTypes.map(() => "?").join(",")})`);
            values.push(...args.obsTypes);
          }
          if (typeof args.dateStartEpoch === "number") {
            where.push("created_at_epoch >= ?");
            values.push(args.dateStartEpoch);
          }
          if (typeof args.dateEndEpoch === "number") {
            where.push("created_at_epoch <= ?");
            values.push(args.dateEndEpoch);
          }
          return this.db
            .query(
              `SELECT * FROM observations
               WHERE ${where.join(" AND ")}
               ORDER BY created_at_epoch ${orderBy}
               LIMIT ? OFFSET ?`
            )
            .all(...values, limit, offset) as any[];
        })()
      : [];

    const sessions = includeSessions
      ? (() => {
          const where: string[] = ["1=1"];
          where.push("deleted_at_epoch IS NULL");
          const values: any[] = [];
          if (q) {
            where.push("(request LIKE ? OR investigated LIKE ? OR learned LIKE ? OR completed LIKE ? OR next_steps LIKE ?)");
            values.push(like, like, like, like, like);
          }
          if (args.project) {
            where.push("project = ?");
            values.push(args.project);
          }
          if (typeof args.dateStartEpoch === "number") {
            where.push("created_at_epoch >= ?");
            values.push(args.dateStartEpoch);
          }
          if (typeof args.dateEndEpoch === "number") {
            where.push("created_at_epoch <= ?");
            values.push(args.dateEndEpoch);
          }
          return this.db
            .query(
              `SELECT * FROM session_summaries
               WHERE ${where.join(" AND ")}
               ORDER BY created_at_epoch ${orderBy}
               LIMIT ? OFFSET ?`
            )
            .all(...values, limit, offset) as any[];
        })()
      : [];

    const prompts = includePrompts
      ? (() => {
          const where: string[] = ["1=1"];
          where.push("up.deleted_at_epoch IS NULL");
          const values: any[] = [];
          if (q) {
            where.push("up.prompt_text LIKE ?");
            values.push(like);
          }
          if (args.project) {
            where.push("s.project = ?");
            values.push(args.project);
          }
          if (typeof args.dateStartEpoch === "number") {
            where.push("up.created_at_epoch >= ?");
            values.push(args.dateStartEpoch);
          }
          if (typeof args.dateEndEpoch === "number") {
            where.push("up.created_at_epoch <= ?");
            values.push(args.dateEndEpoch);
          }
          return this.db
            .query(
              `SELECT up.* FROM user_prompts up
               JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
               WHERE ${where.join(" AND ")}
               ORDER BY up.created_at_epoch ${orderBy}
               LIMIT ? OFFSET ?`
            )
            .all(...values, limit, offset) as any[];
        })()
      : [];

    return { observations, sessions, prompts };
  }

  private touchProjectActivity(projects: string[], atEpoch = Date.now()): void {
    const uniqueProjects = [...new Set(projects.filter((x) => !!x))];
    if (uniqueProjects.length === 0) return;
    const stmt = this.db.query(
      `INSERT INTO project_memory_activity (project, last_accessed_at_epoch, updated_at_epoch)
       VALUES (?, ?, ?)
       ON CONFLICT(project) DO UPDATE SET
         last_accessed_at_epoch = CASE
           WHEN excluded.last_accessed_at_epoch > project_memory_activity.last_accessed_at_epoch
             THEN excluded.last_accessed_at_epoch
           ELSE project_memory_activity.last_accessed_at_epoch
         END,
         updated_at_epoch = excluded.updated_at_epoch`
    );
    for (const p of uniqueProjects) {
      stmt.run(p, atEpoch, atEpoch);
    }
  }

  touchMemoryAccess(args: { observationIds?: number[]; summaryIds?: number[]; promptIds?: number[]; projects?: string[] }, atEpoch = Date.now()): void {
    const obsIds = [...new Set((args.observationIds || []).filter((x) => Number.isInteger(x)))];
    const summaryIds = [...new Set((args.summaryIds || []).filter((x) => Number.isInteger(x)))];
    const promptIds = [...new Set((args.promptIds || []).filter((x) => Number.isInteger(x)))];
    const touchedProjects = new Set<string>((args.projects || []).filter(Boolean));

    if (obsIds.length > 0) {
      const placeholders = obsIds.map(() => "?").join(",");
      this.db
        .query(`UPDATE observations SET last_accessed_at_epoch = ? WHERE deleted_at_epoch IS NULL AND id IN (${placeholders})`)
        .run(atEpoch, ...obsIds);
      const rows = this.db
        .query(`SELECT DISTINCT project FROM observations WHERE id IN (${placeholders})`)
        .all(...obsIds) as Array<{ project: string }>;
      for (const r of rows) if (r.project) touchedProjects.add(r.project);
    }

    if (summaryIds.length > 0) {
      const placeholders = summaryIds.map(() => "?").join(",");
      this.db
        .query(`UPDATE session_summaries SET last_accessed_at_epoch = ? WHERE deleted_at_epoch IS NULL AND id IN (${placeholders})`)
        .run(atEpoch, ...summaryIds);
      const rows = this.db
        .query(`SELECT DISTINCT project FROM session_summaries WHERE id IN (${placeholders})`)
        .all(...summaryIds) as Array<{ project: string }>;
      for (const r of rows) if (r.project) touchedProjects.add(r.project);
    }

    if (promptIds.length > 0) {
      const placeholders = promptIds.map(() => "?").join(",");
      this.db
        .query(`UPDATE user_prompts SET last_accessed_at_epoch = ? WHERE deleted_at_epoch IS NULL AND id IN (${placeholders})`)
        .run(atEpoch, ...promptIds);
      const rows = this.db
        .query(
          `SELECT DISTINCT s.project
           FROM user_prompts up
           JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
           WHERE up.id IN (${placeholders})`
        )
        .all(...promptIds) as Array<{ project: string }>;
      for (const r of rows) if (r.project) touchedProjects.add(r.project);
    }

    this.touchProjectActivity([...touchedProjects], atEpoch);
  }

  listRetentionPolicies(): Array<{ project: string; enabled: boolean; pinned: boolean; ttl_days: number | null; updated_at_epoch: number }> {
    const rows = this.db
      .query("SELECT project, enabled, pinned, ttl_days, updated_at_epoch FROM project_retention_policies ORDER BY project ASC")
      .all() as Array<{ project: string; enabled: number; pinned: number; ttl_days: number | null; updated_at_epoch: number }>;
    return rows.map((r) => ({
      project: r.project,
      enabled: r.enabled === 1,
      pinned: r.pinned === 1,
      ttl_days: r.ttl_days ?? null,
      updated_at_epoch: r.updated_at_epoch
    }));
  }

  upsertRetentionPolicy(project: string, policy: RetentionPolicyInput, atEpoch = Date.now()): void {
    const existing = this.db
      .query("SELECT enabled, pinned, ttl_days FROM project_retention_policies WHERE project = ?")
      .get(project) as { enabled: number; pinned: number; ttl_days: number | null } | null;
    const enabled = policy.enabled ?? (existing ? existing.enabled === 1 : true);
    const pinned = policy.pinned ?? (existing ? existing.pinned === 1 : false);
    const ttlDays = policy.ttlDays === undefined ? (existing ? existing.ttl_days : null) : policy.ttlDays;
    this.db
      .query(
        `INSERT INTO project_retention_policies (project, enabled, pinned, ttl_days, updated_at_epoch)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET
           enabled = excluded.enabled,
           pinned = excluded.pinned,
           ttl_days = excluded.ttl_days,
           updated_at_epoch = excluded.updated_at_epoch`
      )
      .run(project, enabled ? 1 : 0, pinned ? 1 : 0, ttlDays, atEpoch);
  }

  private listRetentionProjects(): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT project FROM (
           SELECT project FROM sdk_sessions
           UNION SELECT project FROM observations
           UNION SELECT project FROM session_summaries
           UNION SELECT project FROM project_memory_activity
           UNION SELECT project FROM project_retention_policies
         )
         WHERE project IS NOT NULL AND project <> ''`
      )
      .all() as Array<{ project: string }>;
    return rows.map((r) => r.project);
  }

  private getProjectRetentionPolicy(project: string): { enabled: boolean; pinned: boolean; ttlDays: number | null } {
    const row = this.db
      .query("SELECT enabled, pinned, ttl_days FROM project_retention_policies WHERE project = ?")
      .get(project) as { enabled: number; pinned: number; ttl_days: number | null } | null;
    if (!row) return { enabled: true, pinned: false, ttlDays: null };
    return {
      enabled: row.enabled === 1,
      pinned: row.pinned === 1,
      ttlDays: row.ttl_days ?? null
    };
  }

  private getProjectLastAccessEpoch(project: string): number | null {
    const row = this.db
      .query(
        `SELECT MAX(v) AS last_epoch FROM (
           SELECT MAX(COALESCE(last_accessed_at_epoch, created_at_epoch)) AS v FROM observations WHERE project = ? AND deleted_at_epoch IS NULL
           UNION ALL
           SELECT MAX(COALESCE(last_accessed_at_epoch, created_at_epoch)) AS v FROM session_summaries WHERE project = ? AND deleted_at_epoch IS NULL
           UNION ALL
           SELECT MAX(COALESCE(up.last_accessed_at_epoch, up.created_at_epoch)) AS v
           FROM user_prompts up
           JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
           WHERE s.project = ? AND up.deleted_at_epoch IS NULL
           UNION ALL
           SELECT last_accessed_at_epoch AS v FROM project_memory_activity WHERE project = ?
         ) WHERE v IS NOT NULL`
      )
      .get(project, project, project, project) as { last_epoch: number | null } | null;
    return row?.last_epoch ?? null;
  }

  runRetentionCleanup(options: RetentionCleanupOptions): RetentionCleanupReport {
    const nowEpoch = options.nowEpoch ?? Date.now();
    const defaultTtlDays = Math.max(1, Math.floor(options.defaultTtlDays));
    const softDeleteDays = Math.max(1, Math.floor(options.softDeleteDays));
    const projects = this.listRetentionProjects();

    const report: RetentionCleanupReport = {
      dryRun: options.dryRun,
      nowEpoch,
      defaultTtlDays,
      softDeleteDays,
      scannedProjects: projects.length,
      skippedPinned: 0,
      skippedDisabled: 0,
      softDeleted: { projects: 0, observations: 0, summaries: 0, prompts: 0 },
      hardDeleted: { observations: 0, summaries: 0, prompts: 0 },
      details: []
    };

    for (const project of projects) {
      const policy = this.getProjectRetentionPolicy(project);
      const ttlDays = policy.ttlDays && policy.ttlDays > 0 ? Math.floor(policy.ttlDays) : defaultTtlDays;
      const lastAccessEpoch = this.getProjectLastAccessEpoch(project);
      const inactiveMs = typeof lastAccessEpoch === "number" ? nowEpoch - lastAccessEpoch : Number.POSITIVE_INFINITY;
      const inactiveDays = Number.isFinite(inactiveMs) ? Number((inactiveMs / DAY_MS).toFixed(2)) : null;
      const expired = inactiveMs >= ttlDays * DAY_MS;

      const obsCount = (this.db
        .query("SELECT COUNT(*) AS c FROM observations WHERE project = ? AND deleted_at_epoch IS NULL")
        .get(project) as { c: number }).c;
      const summaryCount = (this.db
        .query("SELECT COUNT(*) AS c FROM session_summaries WHERE project = ? AND deleted_at_epoch IS NULL")
        .get(project) as { c: number }).c;
      const promptCount = (this.db
        .query(
          `SELECT COUNT(*) AS c
           FROM user_prompts up
           JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
           WHERE s.project = ? AND up.deleted_at_epoch IS NULL`
        )
        .get(project) as { c: number }).c;

      const detail = {
        project,
        ttlDays,
        lastAccessEpoch,
        inactiveDays,
        softDeleteCandidate: false,
        counts: { observations: obsCount, summaries: summaryCount, prompts: promptCount }
      } as RetentionCleanupReport["details"][number];

      if (policy.pinned) {
        report.skippedPinned += 1;
        detail.skippedReason = "pinned";
        report.details.push(detail);
        continue;
      }
      if (!policy.enabled) {
        report.skippedDisabled += 1;
        detail.skippedReason = "disabled";
        report.details.push(detail);
        continue;
      }
      if (!expired) {
        detail.skippedReason = "not_expired";
        report.details.push(detail);
        continue;
      }

      detail.softDeleteCandidate = true;
      report.softDeleted.projects += 1;
      report.softDeleted.observations += obsCount;
      report.softDeleted.summaries += summaryCount;
      report.softDeleted.prompts += promptCount;
      report.details.push(detail);

      if (!options.dryRun) {
        this.db.query("UPDATE observations SET deleted_at_epoch = ? WHERE project = ? AND deleted_at_epoch IS NULL").run(nowEpoch, project);
        this.db.query("UPDATE session_summaries SET deleted_at_epoch = ? WHERE project = ? AND deleted_at_epoch IS NULL").run(nowEpoch, project);
        this.db
          .query(
            `UPDATE user_prompts
             SET deleted_at_epoch = ?
             WHERE deleted_at_epoch IS NULL
               AND content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)`
          )
          .run(nowEpoch, project);
      }
    }

    const hardDeleteCutoff = nowEpoch - softDeleteDays * DAY_MS;
    const hardObs = (this.db
      .query("SELECT COUNT(*) AS c FROM observations WHERE deleted_at_epoch IS NOT NULL AND deleted_at_epoch <= ?")
      .get(hardDeleteCutoff) as { c: number }).c;
    const hardSum = (this.db
      .query("SELECT COUNT(*) AS c FROM session_summaries WHERE deleted_at_epoch IS NOT NULL AND deleted_at_epoch <= ?")
      .get(hardDeleteCutoff) as { c: number }).c;
    const hardPrompt = (this.db
      .query("SELECT COUNT(*) AS c FROM user_prompts WHERE deleted_at_epoch IS NOT NULL AND deleted_at_epoch <= ?")
      .get(hardDeleteCutoff) as { c: number }).c;

    report.hardDeleted = {
      observations: hardObs,
      summaries: hardSum,
      prompts: hardPrompt
    };

    if (!options.dryRun) {
      this.db.query("DELETE FROM user_prompts WHERE deleted_at_epoch IS NOT NULL AND deleted_at_epoch <= ?").run(hardDeleteCutoff);
      this.db.query("DELETE FROM session_summaries WHERE deleted_at_epoch IS NOT NULL AND deleted_at_epoch <= ?").run(hardDeleteCutoff);
      this.db.query("DELETE FROM observations WHERE deleted_at_epoch IS NOT NULL AND deleted_at_epoch <= ?").run(hardDeleteCutoff);
    }

    return report;
  }
}
