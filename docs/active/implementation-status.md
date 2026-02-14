# CodexMem 实现状态

## 当前版本

- 版本：`0.1.0`
- 日期：`2026-02-14`

## 已实现

1. Worker 系统接口
- `GET /api/health`
- `GET /api/readiness`
- `GET /api/version`

2. Session 接口
- `POST /api/sessions/init`
- `POST /api/sessions/observations`
- `POST /api/sessions/summarize`
- `POST /api/sessions/complete`
- `POST /api/sessions/end`（第五阶段：cleanup + complete）

3. 数据读取接口
- `GET /api/observations`
- `GET /api/summaries`
- `GET /api/prompts`
- `GET /api/observation/:id`
- `POST /api/observations/batch`
- `GET /api/projects`
- `GET /api/stats`
- `GET /api/processing-status`
- `POST /api/pending-queue/process`（手动队列恢复）
- `GET /api/ops/retention/policies`（保留策略）
- `POST /api/ops/retention/policies`（设置保留策略）
- `POST /api/ops/retention/cleanup`（TTL 清理 dry-run/execute）

4. 搜索与上下文接口
- `GET /api/search`
- `GET /api/timeline`
- `GET /api/context/inject`
  - 已支持 `type/obs_type/dateStart/dateEnd/format=json` 参数

5. 配置接口
- `GET /api/settings`
- `POST /api/settings`
- `GET /api/mcp/status`
- `POST /api/mcp/toggle`

6. 手动记忆接口
- `POST /api/memory/save`

7. MCP 工具
- `__IMPORTANT`
- `search`
- `timeline`
- `get_observations`
- `save_memory`

8. 第二阶段新增（Phase 2）
- Provider Agent（`openai` 主通道 + `rule-based` 兜底）
- Hook CLI 适配层：
  - 平台适配：`claude-code/cursor/codex/raw`
  - 事件处理：`session-init/observation/summarize/session-complete/session-end`
  - 命令入口：`bun run hook <platform> <event>`
 - Codex 自动后台记忆桥接：
   - 新增 `src/cli/codex-bridge.ts`
   - 命令：`bun run codex:auto-memory`
   - 监听 `~/.codex/sessions/**/*.jsonl` 并自动触发 `init/observation/summarize/session-end`
 - MCP 一键自动引导：
   - `bun run mcp` 自动检测并拉起 worker（若未运行）
   - worker 就绪后自动拉起 `codex-bridge`（默认开启，可用环境变量关闭）
- OpenAI 调用增强：
  - chat/embeddings 客户端统一封装
  - 超时控制 + 429/5xx 自动重试 + 非重试错误告警
  - chat 与 embedding 支持独立 base_url/api_key/model 配置
- 向量检索 Alpha：
  - 新增 `observation_embeddings` 存储
  - observation 入库后自动 embedding 建索引
  - `/api/search` 支持 lexical + semantic hybrid 合并召回
- P1 检索链路对齐（已完成）：
  - 新增 `CODEXMEM_VECTOR_BACKEND=sqlite|chroma|hybrid` 开关
  - 新增 `ChromaSearchService`，支持 observation/summary/prompt 双写与 query 向量召回
  - `/api/search` 改为 `vector -> hydration -> lexical 补充` 合并策略
  - 新增 `backfill:chroma` 回填脚本
- P2 压缩链路对齐（已完成）：
  - 新增严格 schema 校验模块：`src/agents/schema.ts`
  - OpenAI Agent 增加“结构修复重试”流程（`CODEXMEM_OPENAI_REPAIR_ENABLED` / `CODEXMEM_OPENAI_MAX_REPAIRS`）
  - observation/summary 失败分类日志增强（解析失败、schema 失败、修复后失败）
  - 新增 `tests/agent-schema.test.ts` 覆盖严格校验
- P3 Hook 与会话流程矩阵对齐（已完成）：
  - 新增 `tests/hook-matrix.test.ts`，覆盖 `claude-code/cursor/raw × session-init/observation/summarize/session-complete`
  - 覆盖 worker 不可用场景，验证 Hook 退出码恒为 `0`
  - `pending_messages` 引入 `dedupe_key`，并新增 `processed_message_dedupe` 持久幂等表
  - observation/summarize 入队改为稳定哈希幂等，重复事件返回 `status=deduped`
- P4 SSE Viewer 与运维接口对齐（已完成）：
  - 新增 `GET /api/events` SSE 流（`queue.depth/session.status/queue.failed/model.result`）
  - 新增最小 Viewer：`GET /viewer`
  - 新增运维接口：
    - `GET /api/ops/index-status`
    - `POST /api/ops/retry-failed`
    - `POST /api/ops/backfill/chroma`
  - 新增 `tests/sse.test.ts` 覆盖 SSE 订阅与运维接口可用性
- P5 最终对齐验收与发布门禁（已完成）：
  - 新增 `scripts/replay-events.ts`，支持固定事件流回放并导出 candidate 工件
  - 新增 `scripts/release-gate.ts`，聚合 parity/benchmark/soak 并输出统一门禁结论
  - `scripts/parity-report.ts`、`scripts/benchmark.ts` 增加 `--output` 报告落盘能力
  - 新增样例基线输入：`fixtures/p5/replay-events.sample.json`、`fixtures/p5/search-queries.sample.json`
  - 新增 P5 执行文档：`docs/release/p5-release-gate.md`
- T1 质量链路补齐（进行中）：
  - OpenAI Agent 升级为分层 prompt（硬约束 + few-shot + 负例约束）
  - schema 增加统一文本清洗与字段级硬约束（长度、去重、白名单）
  - 新增 agent 失败分类计数：`success/parse_fail/schema_fail/repair_fail/fallback_used`
  - 新增运维接口：`GET /api/ops/agent-metrics`、`POST /api/ops/agent-metrics/reset`
  - 新增质量回放脚本：`scripts/quality-replay.ts`（要求 >=50 events）
  - 新增 T1 回放样例：`fixtures/t1/quality-replay.events.json`（50 events）
- T2 真实基线收敛（执行链路已完成）：
  - 新增 `scripts/t2-convergence.ts`，支持多轮 `replay-events + release-gate` 连续收敛验证
  - 支持连续通过判定与回退阈值判定（recall/searchP95/batchP95）
  - 新增执行文档：`docs/release/t2-baseline-convergence.md`
- T3 高级可观测性（第二版已完成）：
  - `/viewer` 升级为交互面板：search trace / session timings / failure summary / trends
  - `/viewer` 支持过滤（query/project/mode/session/errorClass/from/to）与导出链接
  - trends 升级为 SVG 折线图（search/queue/failure 三条线）
  - 新增 trend drill-down（点击点位按时间桶联动下方明细）
  - 新增 failure surge 告警（最近桶失败数与均值对比）
  - 新增/增强运维接口：
    - `GET /api/ops/search-traces`（含过滤）
    - `GET /api/ops/session-timings`（含过滤）
    - `GET /api/ops/failure-summary`（含过滤）
    - `GET /api/ops/search-traces/export`（CSV/NDJSON）
    - `GET /api/ops/session-timings/export`（CSV/NDJSON）
    - `GET /api/ops/failure-summary/export`（CSV/NDJSON）
    - `GET /api/ops/trends`（窗口趋势聚合）
  - `/api/search` 接入 trace 采集（模式、向量来源、耗时、结果规模）
  - `processSessionQueue` 接入耗时分解与失败分类采集
  - `tests/sse.test.ts` 扩展覆盖高级运维接口可用性
- T4 发布门禁制度化（已完成）：
  - 新增统一发布前工作流脚本：`scripts/t4-release-workflow.ts`
  - 工作流串联执行 `bun test` + `scripts/release-gate.ts`
  - 报告归档到 `artifacts/p5/reports/<timestamp>/`
  - 失败自动生成 `remediation.md` 修复/复测模板
- ClaudeMem 实时功能对齐验证（已完成）：
  - 新增脚本：`scripts/claudemem-live-parity.ts`
  - 新增命令：`bun run test:claudemem-live-parity -- ...`
  - 覆盖对齐检查：health/readiness/version、memory/save、observations、observation/:id、search、context/inject、timeline
  - 最新报告：`artifacts/parity/live-parity-report.json`（`passed=true`）
- 队列恢复测试自动化：
  - 新增 `tests/queue-recovery.test.ts`
  - 覆盖 claim->store->confirm、stale reset 恢复、重试上限失败
- 队列恢复策略对齐（已更新）：
  - 新增 `CODEXMEM_AUTO_RECOVER_ON_BOOT`（默认 `false`）
  - 默认不在 worker 启动时自动恢复，改为手动调用 `POST /api/pending-queue/process`
 - 低价值工具过滤对齐（已更新）：
  - 默认 `CODEXMEM_SKIP_TOOLS=ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`
  - 新增 session-memory 元文件操作过滤：`Edit/Write/Read/NotebookEdit` 命中 `session-memory` 返回 `reason=session_memory_meta`
 - 记忆保留与自动清理（已完成）：
  - 新增访问时间字段：`last_accessed_at_epoch` 与软删字段 `deleted_at_epoch`
  - 新增项目活动表与策略表：`project_memory_activity`、`project_retention_policies`
  - 新增按项目 TTL（默认 30 天）自动软删，延迟硬删（默认 7 天）
  - Worker 启动后按配置周期自动清理（默认每天一次）
- Parity 自动对比脚本（第三阶段）：
  - 新增 `scripts/parity-report.ts`
  - 支持 observation 条数、project/type 分布、Top-N 召回率自动对比与门禁
- 契约回归测试（第四阶段）：
  - 新增 `tests/contract.test.ts`
  - 覆盖 health/readiness/version、session init 幂等、observations/batch 参数错误语义、search format=json、mcp toggle/status
- MCP E2E 测试（第四阶段）：
  - 新增 `tests/mcp-e2e.test.ts`
  - 覆盖 MCP 5 工具全链路与 `save_memory -> search -> timeline -> get_observations` 闭环
- 性能基准脚本（第五阶段）：
  - 新增 `scripts/benchmark.ts`
  - 支持 `search P95` 与 `observations/batch P95` 自动评估与阈值门禁
- 长稳压测脚本（第五阶段）：
  - 新增 `scripts/soak.ts`
  - 支持 24h 运行、进程 RSS/接口可用性采样、报告导出与门禁

## 与 Claude-Mem 的差异（当前）

1. 在实时功能对齐脚本覆盖范围内，未发现核心链路能力缺口。
2. 模型策略可配置项存在实现差异（provider/prompt 风格），但不影响 HTTP/MCP 功能对齐。
3. 质量与召回阈值仍建议使用你们真实生产 baseline 定期复验。

## 下一阶段建议

1. 引入真实生产基线数据，周期性执行 `test:release-gate` 并归档报告。
2. 强化 SSE 验收（断线重连、事件顺序与去重）。
3. 增加高级追踪视图的交互能力（过滤、下载、按 session drill-down）。
