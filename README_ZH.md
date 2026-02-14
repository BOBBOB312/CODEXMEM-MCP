# CodexMem

English documentation: `README.md`

CodexMem 是一个面向 Codex / MCP 场景的持久记忆服务。它通过 Hook 事件采集、异步队列处理、结构化压缩与检索能力，把会话中的高价值信息沉淀为可跨会话复用的记忆。

English version: `/Users/zzz/fun/mem/codexmem/README_EN.md`

项目目标：
- 在 Codex App 中实现“连接 MCP 后自动记忆”。
- 兼容 ClaudeMem 的核心机制与流程语义。
- 提供工程化的可观测性、回归测试和发布门禁。

## 核心能力

- 自动记忆链路（默认开启）：`session-init -> observation -> summarize -> session-end(cleanup)`。
- 多平台 Hook 适配：`claude-code`、`cursor`、`codex`、`raw`。
- MCP 五工具：`__IMPORTANT`、`search`、`timeline`、`get_observations`、`save_memory`。
- 向量检索：支持 `sqlite`、`chroma`、`hybrid` 三种后端模式。
- 队列幂等与恢复：`pending/processing/failed` 状态机 + dedupe。
- 可观测性：SSE 流、Viewer 面板、搜索与耗时追踪、失败分类、趋势导出。
- 记忆保留策略：按项目 TTL 自动清理（软删 + 延迟硬删，可 dry-run）。

## 架构概览

- `src/worker/server.ts`：Worker API 与队列消费核心。
- `src/mcp/server.ts`：MCP Server（stdio），负责对外工具服务。
- `src/cli/codex-bridge.ts`：监听 `~/.codex/sessions/**/*.jsonl` 并桥接为 Worker 事件。
- `src/db/store.ts`：SQLite 存储层（会话、观测、总结、队列、向量、保留策略）。

流程：
1. Codex 会话触发事件（用户消息、工具调用、会话收尾）。
2. Bridge 将事件发送到 Worker API。
3. Worker 将 observation/summarize 入队并异步消费。
4. Agent 生成结构化记忆，写入数据库并建立向量索引。
5. MCP `search/timeline/get_observations` 提供后续检索。

## 快速开始

### 1) 安装依赖

```bash
cd /Users/zzz/fun/mem/codexmem
bun install
```

### 2) 启动方式（推荐）

```bash
bun run mcp
```

说明：
- MCP 启动时会自动探活 Worker。
- Worker 不可用时会自动拉起 Worker。
- Worker 就绪后会自动拉起 `codex-bridge`，实现后台自动记忆。

### 3) Codex App MCP 配置示例

配置文件：`/Users/zzz/.codex/config.toml`

```toml
[mcp_servers.codexmem]
command = "zsh"
args = [ "-lc", "cd /Users/zzz/fun/mem/codexmem && bun run mcp" ]
```

## 常用命令

- 启动 Worker：`bun run worker`
- 启动 MCP：`bun run mcp`
- 启动自动桥接：`bun run codex:auto-memory`
- Hook 调用示例：`echo '{"session_id":"sess-1","cwd":"/tmp","prompt":"hello"}' | bun run hook codex session-init`
- 类型检查：`bun run check`
- 全量测试：`bun test`

## 配置说明

配置文件：`~/.codexmem/settings.json`

### 基础配置

- `CODEXMEM_WORKER_HOST`：Worker Host，默认 `127.0.0.1`
- `CODEXMEM_WORKER_PORT`：Worker Port，默认 `37777`
- `CODEXMEM_MCP_ENABLED`：MCP 是否启用，默认 `true`
- `CODEXMEM_PROVIDER`：记忆压缩 provider，默认 `openai`

### 模型配置（OpenAI-compatible）

- `CODEXMEM_OPENAI_MODEL`：主模型，默认 `gpt-4o-mini`
- `CODEXMEM_OPENAI_EMBEDDING_MODEL`：向量模型，默认 `text-embedding-3-small`
- `CODEXMEM_OPENAI_BASE_URL`：主模型网关
- `CODEXMEM_OPENAI_API_KEY`：主模型密钥
- `CODEXMEM_OPENAI_EMBEDDING_BASE_URL`：向量网关（可空，默认继承主网关）
- `CODEXMEM_OPENAI_EMBEDDING_API_KEY`：向量密钥（可空，默认继承主密钥）

### 向量检索配置

- `CODEXMEM_VECTOR_BACKEND`：`sqlite | chroma | hybrid`
- `CODEXMEM_CHROMA_URL`：Chroma 地址
- `CODEXMEM_CHROMA_COLLECTION`：Chroma 集合名

### 自动化与稳定性配置

- `CODEXMEM_SKIP_TOOLS`：低价值工具过滤列表
  - 默认：`ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`
- `CODEXMEM_STALE_PROCESSING_MS`：stale processing 重置阈值（毫秒）
- `CODEXMEM_AUTO_RECOVER_ON_BOOT`：是否开机自动恢复队列（默认 `false`）

### MCP 自动引导开关（环境变量）

- `CODEXMEM_MCP_AUTO_BOOTSTRAP=false`：关闭 MCP 自动拉起 Worker
- `CODEXMEM_MCP_AUTO_BRIDGE=false`：关闭 MCP 自动拉起 Bridge
- `CODEXMEM_MCP_STOP_WORKER_ON_EXIT=true`：MCP 退出时停止其拉起的 Worker

### 记忆保留（TTL）配置

- `CODEXMEM_RETENTION_ENABLED`：是否启用自动清理（默认 `true`）
- `CODEXMEM_RETENTION_TTL_DAYS`：默认 TTL 天数（默认 `30`）
- `CODEXMEM_RETENTION_SOFT_DELETE_DAYS`：软删后硬删延迟天数（默认 `7`）
- `CODEXMEM_RETENTION_SWEEP_INTERVAL_MIN`：清理周期分钟数（默认 `1440`）

## API 概览

### 核心健康接口

- `GET /api/health`
- `GET /api/readiness`
- `GET /api/version`

### 会话与记忆接口

- `POST /api/sessions/init`
- `POST /api/sessions/observations`
- `POST /api/sessions/summarize`
- `POST /api/sessions/end`
- `POST /api/sessions/complete`（兼容）
- `POST /api/memory/save`

### 查询接口

- `GET /api/search`
- `GET /api/timeline`
- `GET /api/context/inject`
- `GET /api/observations`
- `GET /api/summaries`
- `GET /api/prompts`
- `GET /api/observation/:id`
- `POST /api/observations/batch`

### 运维接口

- `GET /api/processing-status`
- `POST /api/pending-queue/process`
- `POST /api/ops/retry-failed`
- `POST /api/ops/backfill/chroma`
- `GET /api/events`
- `GET /viewer`
- `GET /api/ops/search-traces`
- `GET /api/ops/session-timings`
- `GET /api/ops/failure-summary`
- `GET /api/ops/trends`
- `GET /api/ops/index-status`

### 保留策略接口（TTL）

- `GET /api/ops/retention/policies`
- `POST /api/ops/retention/policies`
- `POST /api/ops/retention/cleanup`

## 记忆保留策略（TTL）

策略说明：
- 以“最后访问时间”判断是否过期，不是仅看创建时间。
- 默认到期后先软删，软删窗口结束再硬删。
- 支持项目级策略：`enabled`、`pinned`、`ttlDays`。

建议实践：
1. 先跑 `dry-run` 看候选删除量。
2. 再执行真实清理。
3. 对关键项目设置 `pinned=true`。

## 测试与验收

- 契约测试：`bun test tests/contract.test.ts`
- Hook 矩阵：`bun run test:hook-matrix`
- MCP E2E：`bun run test:mcp-e2e`
- 全量测试：`bun test`

门禁相关：
- Parity：`bun run test:parity`
- Benchmark：`bun run test:benchmark`
- Soak：`bun run test:soak`
- Release Gate：`bun run test:release-gate`

## 故障排查

- MCP 已连通但无记忆：
  - 检查 `GET /api/health`
  - 确认 `codex-bridge` 进程存在
  - 确认会话中有工具调用或空闲收尾事件
- 记忆量异常减少：
  - 检查 retention 配置与 `POST /api/ops/retention/cleanup` 执行记录
  - 用 `dry-run` 复核策略
- 搜索召回不稳定：
  - 检查 `CODEXMEM_VECTOR_BACKEND`
  - 检查 embedding 配置和 Chroma 可用性

## 文档索引

- `docs/api-contract.md`
- `docs/data-schema.md`
- `docs/session-state-machine.md`
- `docs/compatibility-matrix.md`
- `docs/implementation-status.md`
- `docs/codex-auto-memory.md`
- `docs/p5-release-gate.md`
- `docs/t2-baseline-convergence.md`
- `docs/t4-release-workflow.md`
- `docs/claudemem-live-parity.md`

## 开发规范

- 代码：TypeScript + Bun
- 存储：SQLite（WAL）
- 约束：优先保持接口语义稳定，新增能力尽量通过可配置开关扩展

## 路线图建议

- 更细粒度的 retention 审计日志与告警。
- Viewer 增加 retention 可视化与候选删除预览。
- 多工作区策略模板与批量策略管理。

## 贡献

欢迎提交 Issue / PR。建议先附带：
- 问题复现步骤
- 预期行为与实际行为
- 相关日志与配置片段

## 许可证

本项目采用 **MIT License**。

详见：`/Users/zzz/fun/mem/codexmem/LICENSE`
