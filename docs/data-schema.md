# CodexMem 数据模型与迁移规范（对齐 Claude-Mem）

## 1. 目标

本文给出 `codexmem` 需要实现的最小可等价数据结构（SQLite），以及迁移顺序与约束，作为数据库实现依据。

## 2. 核心表（必需）

## 2.1 `sdk_sessions`

用途：
- 以 `content_session_id` 绑定用户会话
- 以 `memory_session_id` 绑定记忆代理会话（可空，后续回填）

建议 DDL：
```sql
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
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_content ON sdk_sessions(content_session_id);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_memory ON sdk_sessions(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);
```

## 2.2 `user_prompts`

用途：
- 保存每个 `content_session_id` 下的 prompt 序号与清洗文本

建议 DDL：
```sql
CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(content_session_id, prompt_number);
CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
```

## 2.3 `observations`

用途：
- 存储结构化观察（title/subtitle/facts/narrative/concepts/files）

建议 DDL：
```sql
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
CREATE INDEX IF NOT EXISTS idx_observations_memory ON observations(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
```

## 2.4 `session_summaries`

用途：
- 存储总结分区（request/investigated/learned/completed/next_steps）

建议 DDL：
```sql
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
CREATE INDEX IF NOT EXISTS idx_summaries_memory ON session_summaries(memory_session_id);
CREATE INDEX IF NOT EXISTS idx_summaries_project ON session_summaries(project);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON session_summaries(created_at_epoch DESC);
```

## 2.5 `pending_messages`

用途：
- 持久化工作队列，保证崩溃恢复与重试

建议 DDL：
```sql
CREATE TABLE IF NOT EXISTS pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_db_id INTEGER NOT NULL,
  content_session_id TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('observation','summarize')),
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
CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_messages(session_db_id);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_messages(status);
CREATE INDEX IF NOT EXISTS idx_pending_content_session ON pending_messages(content_session_id);
```

## 3. 查询/检索要求

1. 无 query 的 filter-only 搜索必须直接走 SQLite 过滤。
2. 有 query 时优先走向量检索（如可用），并用 SQLite hydration 结果。
3. `ids` 批量读取要支持附加过滤（project/type/concepts/files）。

## 4. 事务要求

`storeObservations` 必须事务化：
1. 批量插入 observations
2. 可选插入 summary
3. 成功后才允许确认/删除 pending message

## 5. 关键一致性约束

1. `memory_session_id` 初始可空，禁止默认写成 `content_session_id`。
2. FK 必须包含 `ON UPDATE CASCADE`，否则会在 session id 回填时触发约束问题。
3. `pending_messages` 状态机最少支持：`pending -> processing -> (pending|failed|processed)`。

## 6. 迁移顺序建议

1. 建 `schema_versions`
2. 建 `sdk_sessions`
3. 建 `observations/session_summaries`
4. 建 `user_prompts`
5. 建 `pending_messages`
6. 增量迁移（列重命名、failed_at_epoch、FK on update cascade）

每个迁移需满足：
- 幂等可重跑
- 可中断恢复
- 失败回滚（尽量事务包裹）

