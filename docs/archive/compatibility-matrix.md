# Claude-Mem 与 CodexMem 兼容矩阵

## 1. 说明

矩阵目标：把 `claude-mem` 的关键机制映射到 `codexmem` 的实现任务，避免“功能名一致但机制不一致”。

## 2. 兼容矩阵

| 能力域 | Claude-Mem 现状 | CodexMem 对齐要求 | 验收点 |
|---|---|---|---|
| MCP 工具集 | 5 工具：`__IMPORTANT/search/timeline/get_observations/save_memory` | 工具名、参数语义、错误语义一致 | `tools/list` 与 `tools/call` 全通过 |
| MCP 架构 | 薄封装，转发到 Worker HTTP | 保持薄封装，不在 MCP 层写业务逻辑 | 代码审查无业务 SQL/解析逻辑 |
| Session Init | `/api/sessions/init` 幂等创建 session + prompt 序号 | 同步实现幂等 get-or-create 与 prompt 编号 | 同一 contentSessionId 多次 init 不新增 session |
| Observation 入队 | `/api/sessions/observations` 入 `pending_messages` | 先持久化再 emit 唤醒 + 幂等去重 | 崩溃后消息可恢复，重复 payload 不重复入库 |
| Summarize 入队 | `/api/sessions/summarize` 入队 | 与 observation 同队列语义 + 幂等去重 | 总结任务可重试，重复 payload 不重复入库 |
| Session Complete | `/api/sessions/complete` 清理 active map | 支持“非活动会话返回 skipped” | 重复调用不报错 |
| Prompt 隐私 | 私有标签清洗后空文本即跳过 | 同规则 | private prompt 不会入库存储 |
| Tool 过滤 | skip tools + meta 文件操作过滤 | 同规则（配置驱动） | 指定工具不入队 |
| Queue 处理 | `pending -> processing -> confirm/delete` | 同状态机，避免消息丢失 | 中途 crash 不丢消息 |
| 失败重试 | `retry_count` + maxRetries + failed | 同策略 | 超过上限进入 failed |
| 启动恢复 | reset stale processing + process pending sessions | 同恢复路径 | 重启后自动恢复处理 |
| 数据模型 | `sdk_sessions/observations/session_summaries/user_prompts/pending_messages` | 至少实现同语义表与索引 | DDL 对照通过 |
| memory_session_id | 由 agent 首次响应捕获并回填 | 严禁默认等于 contentSessionId | 多轮会话 resume 正常 |
| 搜索策略 | query 场景语义检索，filter-only 走 SQLite | 保持双路径 | 两类查询结果正确 |
| 模型提供方 | 多 provider（Claude/Gemini/OpenRouter） | Codex 场景收敛为 OpenAI（失败时 rule-based 兜底） | 无 key/失败时仍可持续处理队列 |
| 批量详情 | `/api/observations/batch` 严格校验 ids | 校验与错误码一致 | 非整数 ids 返回 400 |
| Hook 兼容矩阵 | 多平台多事件统一回调语义 | 覆盖 `claude-code/cursor/raw × 4 events` | `test:hook-matrix` 全通过 |
| SSE 可观测性 | 队列/会话/失败事件可流式订阅 | `GET /api/events` + `/viewer` 最小可视化 | `test:sse` 通过 |
| 运维接口 | 重试失败、索引状态、回填触发 | `/api/ops/retry-failed` `/api/ops/index-status` `/api/ops/backfill/chroma` | 接口契约与回归测试通过 |
| 发布门禁流水线 | 固定输入回放 + 多指标自动门禁 | `replay-events` + `release-gate` 脚本 | `test:release-gate` 可输出统一通过/失败结论 |
| 读写 API | health/readiness/version + data routes + settings | 核心接口保持路径与语义 | API 回归通过 |
| 配置系统 | settings.json + 默认值 +缓存 | 同机制（可实现简化版） | 更新 settings 后新值生效 |
| 可观测性 | 日志 + 状态接口 | 最少保留结构化日志与 stats | 可定位 session/message 失败点 |
| 进程管理 | worker/mcp 生命周期管理与清理 | 实现最小版：健康、启动、停机、恢复 | 连续运行稳定 |

## 3. 高风险差异点（优先对齐）

1. `memory_session_id` 捕获与回填流程。
2. pending 队列的“确认删除”时机。
3. hook 降级策略（不可因为 worker 抖动阻塞主流程）。
4. filter-only 与 semantic search 的分流逻辑。

## 4. 开发优先级建议

1. P0：Session/Queue/Store 原子链路
2. P0：MCP 5 工具与 batch 接口
3. P1：搜索策略一致性（query/filter-only）
4. P1：settings 与 skip/privacy 规则
5. P2：UI/SSE/扩展集成
