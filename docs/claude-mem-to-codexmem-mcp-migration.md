# Claude-Mem -> CodexMem MCP 迁移文档

## 1. 目标与范围

本迁移的目标是：在 `codexmem` 中实现与 `claude-mem` 等价的核心能力，并以 MCP 形式对外提供，保证“功能行为一致、接口语义一致、数据结果一致（允许字段顺序与非关键文案差异）”。

本文件覆盖：
- 迁移内容（需要做什么）
- 验收标准（如何证明等价）

## 2. 源项目能力基线（作为等价标准）

基于当前仓库源码，`claude-mem` 的核心能力基线如下：

1. MCP 工具层（`src/servers/mcp-server.ts`）
- `__IMPORTANT`
- `search`
- `timeline`
- `get_observations`
- `save_memory`
- MCP Server 是“薄封装”：将工具调用转发到 Worker HTTP API。

2. Worker HTTP 能力层（`src/services/worker-service.ts` + routes）
- 搜索/上下文：`/api/search`、`/api/timeline`、`/api/context/inject` 等
- 数据读取：`/api/observations`、`/api/observation/:id`、`/api/observations/batch`、`/api/summaries`、`/api/prompts`
- 会话链路：`/api/sessions/init|observations|summarize|complete`
- 系统能力：`/api/health`、`/api/readiness`、`/api/version`
- 配置能力：`/api/settings`、`/api/mcp/status`、`/api/mcp/toggle`
- 手动记忆写入：`/api/memory/save`

3. 数据与检索层
- SQLite 为主存储（会话、观察、总结、提示词、队列表等）
- FTS 检索 + 时间线查询
- Chroma 同步（语义检索混合）

4. 采集与异步处理链路
- Hook 事件驱动（SessionStart、UserPromptSubmit、PostToolUse、Stop）
- Tool 使用观测异步入队、后台处理、失败降级与重试/恢复

## 3. CodexMem 迁移内容

## 3.1 架构迁移

1. 在 `codexmem` 建立三层结构：
- `mcp-server`：仅处理 MCP 协议、工具 schema、参数转发
- `worker-api`：承载业务逻辑与 HTTP 接口
- `storage`：SQLite +（可选）向量库同步层

2. 保持“薄 MCP + 厚 Worker”模式，避免在 MCP 层承载业务逻辑。

## 3.2 MCP 工具迁移（必须等价）

必须实现并保持语义一致：
- `__IMPORTANT`：返回 3-layer workflow 说明
- `search`：索引级检索（轻量）
- `timeline`：围绕 anchor/query 的上下文时间线
- `get_observations`：按 `ids` 批量取详情
- `save_memory`：手工写入记忆

要求：
- 工具入参兼容现有参数名（如 `query`、`limit`、`project`、`dateStart/dateEnd`、`ids`）
- `get_observations` 要求 `ids` 为数组且必填
- 工具错误返回统一为 MCP 可消费的 `isError + content[]` 结构

## 3.3 Worker API 迁移（必须等价）

至少完成以下接口（路径与语义等价）：

1. 核心健康接口
- `GET /api/health`
- `GET /api/readiness`
- `GET /api/version`

2. 搜索与上下文接口
- `GET /api/search`
- `GET /api/timeline`
- `GET /api/context/inject`

3. 数据读取接口
- `GET /api/observations`
- `GET /api/observation/:id`
- `POST /api/observations/batch`
- `GET /api/summaries`
- `GET /api/prompts`
- `GET /api/projects`
- `GET /api/stats`

4. 会话处理接口
- `POST /api/sessions/init`
- `POST /api/sessions/observations`
- `POST /api/sessions/summarize`
- `POST /api/sessions/complete`

5. 配置与开关接口
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/mcp/status`
- `POST /api/mcp/toggle`

6. 手工记忆接口
- `POST /api/memory/save`

## 3.4 数据模型迁移

1. 迁移最小必需表：
- `sdk_sessions`
- `observations`
- `session_summaries`
- `user_prompts`（若当前实现命名不同，保持语义字段一致）
- `pending_messages`（或等价队列表）

2. 字段语义必须保持：
- 会话标识：`content_session_id` / `memory_session_id`
- 观察核心：`project`、`type`、`title`、`narrative`、`created_at_epoch`
- 总结核心：`request`、`investigated`、`learned`、`completed`、`next_steps`

3. 索引要求：
- 时间倒序查询索引（created_at_epoch）
- project 过滤索引
- 检索索引（FTS 或等价实现）

## 3.5 处理链路迁移

1. 保持“写入观测 -> 异步处理 -> 可检索结果”的最终一致性链路。
2. 保持异常分层：
- Worker 不可用：hook 侧降级，不阻塞主流程
- 参数错误（4xx）与系统错误（5xx）区分
3. 保持会话恢复能力：
- 启动时处理 pending 队列
- 避免无限重启/无限重试（需有上限）

## 3.6 配置与运行迁移

1. 在 `codexmem` 提供 settings 文件与默认值加载逻辑。
2. 支持 worker host/port、provider、log level 等关键配置。
3. 支持本机管理接口（重启/关闭可后置，建议第一阶段先保留状态接口）。

## 4. 实施阶段建议

1. Phase A（骨架）
- 建立项目目录与模块边界
- 跑通 `health/readiness/version`

2. Phase B（MCP + 搜索最小闭环）
- 实现 5 个 MCP 工具
- 打通 `search/timeline/get_observations/save_memory`

3. Phase C（会话与异步处理）
- 接入 sessions 四个接口
- 建立 pending 队列与后台处理器

4. Phase D（配置与兼容）
- settings + mcp toggle
- 参数校验、错误语义、兼容性回归

5. Phase E（验收与压测）
- 全量功能验收
- 稳定性与恢复测试

## 5. 验收标准（功能完全一致）

以下条目全部通过，才可判定“迁移完成”。

## 5.1 MCP 工具验收

1. `tools/list` 返回且仅返回目标 5 工具（允许描述文案微差）。
2. `search` 调用可返回索引结果，支持 `query/project/type/limit`。
3. `timeline` 支持 `anchor` 或 `query` 两种入口。
4. `get_observations` 对非法 `ids` 返回 400 语义错误；合法 `ids` 批量返回详情。
5. `save_memory` 成功后可在 `search` 中检索到。

## 5.2 HTTP 接口验收

1. `/api/health`：服务启动后立即 200。
2. `/api/readiness`：初始化完成前 503，完成后 200。
3. `/api/search`：支持分页/过滤，结果稳定可复现。
4. `/api/observations/batch`：空数组返回空集合；非整数 ID 返回 400。
5. `/api/sessions/*`：init->observations->summarize->complete 全链路可达。

## 5.3 数据一致性验收

1. 同一输入事件流，在 `claude-mem` 与 `codexmem` 中：
- observation 条数一致
- project/type 分布一致
- 可检索命中集合一致（允许排序近似差异，但 Top-N 召回率 >= 95%）

2. `save_memory` 写入后：
- SQLite 有对应记录
- 批量详情接口可读取
- 搜索接口可命中

## 5.4 异常与恢复验收

1. Worker 关闭时，hook 调用不阻塞主流程（降级成功）。
2. 人为注入处理失败后，pending 队列可恢复处理。
3. 重启后不会出现无限拉起/无限重试。
4. 4xx/5xx 错误语义清晰，日志含必要上下文（endpoint/session/project）。

## 5.5 性能与稳定性验收

1. `search` P95 < 300ms（1w observations，本机基准）。
2. `observations/batch`（50 ids）P95 < 500ms。
3. 连续运行 24h 无进程泄漏（worker/mcp 子进程数量稳定）。
4. 内存无持续线性增长（稳态波动可接受）。

## 5.6 回归测试验收

最少测试集：
- 单元测试：搜索参数解析、ID 校验、settings 校验、错误分类
- 集成测试：MCP -> HTTP -> DB 全链路
- 端到端：会话初始化、工具观测写入、总结、检索回读

通过门槛：
- 核心链路测试通过率 100%
- 总体通过率 >= 95%

## 6. 交付物清单

迁移完成时应至少交付：

1. `codexmem` MCP 服务实现（5 tools）
2. `codexmem` Worker API（本文件列出的关键接口）
3. DB migration 与初始化脚本
4. 自动化测试（unit/integration/e2e）
5. 运维文档（启动、配置、故障恢复）
6. 与 `claude-mem` 的差异说明（如有）

## 6.1 配套实施文档（本次补充）

为保证“可直接开发”与“可执行验收”，请与本文件配套使用：

1. `api-contract.md`：MCP/HTTP 请求响应契约、错误语义
2. `data-schema.md`：SQLite 表结构、索引、迁移顺序
3. `session-state-machine.md`：会话/队列/worker 状态机
4. `compatibility-matrix.md`：功能映射与高风险差异点
5. `acceptance-test-cases.md`：端到端验收用例与通过标准

## 7. 不通过条件（任一命中即验收失败）

1. MCP 工具缺失或参数语义不兼容
2. `search/timeline/get_observations` 任一链路不可用
3. 会话观测无法异步落库或不可检索
4. 无法稳定恢复 pending 队列
5. 健康检查与就绪检查语义不正确

## 8. 备注

为降低迁移风险，建议先“兼容优先”再“优化重构”：
- 第一阶段优先保持接口和行为一致
- 第二阶段再做内部重构（例如替换检索策略、优化模型接入）

## 9. 当前落地状态

当前 `codexmem` 已有第一版可运行骨架实现，详细见：
- `implementation-status.md`

已落地范围：
- Worker 核心 API（health/readiness/version、sessions、search、batch、save_memory）
- SQLite 基础 schema 与队列处理
- MCP 5 工具与 HTTP 转发
- Phase 2：Provider Agent 抽象层 + Hook CLI 适配层（claude-code/cursor/raw）

尚未完全对齐范围：
- Chroma 同步路径（当前已具备 OpenAI Embedding + SQLite 语义检索 Alpha）
- 完整 provider agent 压缩链路（当前已收敛为 OpenAI 主通道）
- 完整 hook CLI 适配与 SSE Viewer
