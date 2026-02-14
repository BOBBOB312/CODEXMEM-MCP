# CodexMem 与 Claude-Mem 完全对齐实施计划

## 1. 目标定义（"完全对齐"）

完全对齐指：在相同输入事件流下，`codexmem` 与 `claude-mem` 在以下维度满足一致性门槛：

1. 功能一致：MCP 工具、Worker API、Hook 行为、搜索语义一致。
2. 数据一致：observation/summary/prompt 的核心字段与统计分布一致。
3. 检索一致：关键查询 Top-N 召回率 >= 95%，并具备同等降级语义。
4. 运行一致：队列恢复、错误分类、可观测性、长稳行为达到同等级别。

## 2. 当前差距（必须补齐）

1. 检索链路：仅有 SQLite + OpenAI embedding alpha，缺少 Chroma 同步与双引擎一致性。
2. 压缩链路：主模型提示词/约束仍为轻量版，未对齐 claude-mem 的生产级结构化策略。
3. 可观测性：缺 SSE Viewer 与高级运维接口。
4. 兼容细节：部分 Hook 事件矩阵与降级策略仍需逐项回归。
5. 对齐证明：缺“固定输入流 -> 双系统对比 -> 报告归档”流水线。

## 3. 实施原则

1. 先对齐行为，再优化实现。
2. 每阶段必须有自动化验收脚本，不以人工口头验证作为完成标准。
3. 高风险改造（Chroma、队列恢复、provider 失败切换）都要有回滚开关。

## 4. 分阶段计划

## Phase P1：检索链路完全对齐（Chroma 双引擎）

状态：`已完成（2026-02-14）`

目标：恢复与 claude-mem 一致的 `query -> vector -> hydration` 主路径。

实施项：
1. 接入 `ChromaSync` 等价模块：observation/summary/prompt 双写到 SQLite + Chroma。
2. 搜索策略改为：
- query 存在：优先向量召回（Chroma）+ SQLite 过滤/补充 + 去重排序。
- query 不存在：纯 SQLite 过滤。
3. 建立回填任务：对历史数据执行 backfill，并记录进度。
4. 增加开关：`CODEXMEM_VECTOR_BACKEND=sqlite|chroma|hybrid`。

验收标准：
1. `test:parity` 在带 query 数据集上 Top-N 召回率 >= 95%。
2. 语义检索失败时返回可读降级信息，主链路不中断。
3. backfill 可重复执行且幂等。

## Phase P2：压缩链路对齐（Prompt + Schema + Fallback）

状态：`已完成（2026-02-14）`

目标：使 observation/summary 的质量与稳定性对齐 claude-mem。

实施项：
1. 引入严格 JSON Schema 校验层（失败分类：可修复/不可修复）。
2. 升级 Prompt 策略：few-shot、类型白名单、字段长度与数组上限硬约束。
3. 增加二次修复流程：首次解析失败时进行一次“结构修复重试”。
4. 完善 fallback：API 失败、格式失败、超时失败分级处理并打点。

验收标准：
1. 固定 30 条事件流回放中，结构化解析成功率 >= 99%。
2. 无非法字段入库（schema violation = 0）。
3. Fallback 不导致队列堆积（pending 不持续增长）。

## Phase P3：Hook 与会话流程矩阵对齐

状态：`已完成（2026-02-14）`

目标：对齐 claude-mem 的会话生命周期与多平台 Hook 行为。

实施项：
1. 补齐事件矩阵回归：`session-init/observation/summarize/session-complete` 在 `claude-code/cursor/raw` 全覆盖。
2. 增加异常场景回放：worker 不可用、网络失败、非法 payload、重复事件。
3. 完善幂等键策略：防止重复写 observation/summary。

验收标准：
1. `test:hook-matrix`（新增）全通过。
2. 重复事件输入不产生重复 observation（去重命中率 100%）。
3. Worker 下线时 Hook 始终 exit 0 且主流程不阻塞。

## Phase P4：SSE Viewer 与运维接口对齐

状态：`已完成（2026-02-14）`

目标：补齐可观测性与运维能力。

实施项：
1. 增加 SSE 流：队列深度、会话处理状态、失败事件、最近模型调用结果。
2. Viewer 最小版：查看 sessions/queue/errors/search trace。
3. 增加运维接口：失败重试、手动 backfill、索引状态查询。

验收标准：
1. `test:sse`（新增）验证事件可订阅、断线重连、顺序一致。
2. 可在 UI 观察 pending/failed 变化并触发恢复动作。

## Phase P5：最终对齐验收与发布门禁

状态：`已完成（2026-02-14）`

目标：形成“可重复执行”的完全对齐证据链。

实施项：
1. 固定基线数据集与回放脚本（claude-mem 与 codexmem 同输入）。
2. 自动生成对比报告：条数、分布、Top-N、错误率、P95、24h 稳定性。
3. 建立发布门禁：任一关键指标不达标则禁止发布。

验收标准（DoD）：
1. 功能：`test:contract`、`test:mcp-e2e`、`test:queue-recovery`、`test:hook-matrix`、`test:sse` 全绿。
2. 对齐：`test:parity` 达标（Top-N >= 95%，分布偏差在阈值内）。
3. 性能：`test:benchmark` 达标（search P95 < 300ms，batch P95 < 500ms）。
4. 稳定：`test:soak`（24h）通过，无持续线性内存增长、无不可恢复失败。

## 5. 建议任务拆分（可直接创建 issue）

1. `feat/search-chroma-hybrid`：接入 Chroma 双写与混合召回。
2. `feat/agent-schema-hardening`：Prompt 与 Schema 强化。
3. `feat/hook-matrix-tests`：多平台 Hook 矩阵自动化。
4. `feat/sse-viewer-minimum`：SSE + 最小 Viewer。
5. `feat/parity-gate-pipeline`：完整对齐报告流水线。

## 6. 风险与回滚

1. 风险：Chroma 不稳定导致 query 波动。
- 处理：保留 `CODEXMEM_VECTOR_BACKEND` 开关，支持快速切回 `sqlite`。
2. 风险：主模型提示词升级导致字段分布突变。
- 处理：灰度开关 + 双写对比 + 回放验证后切换。
3. 风险：SSE 引入额外资源占用。
- 处理：独立路由与采样频率可配置，超限自动降采样。

## 7. 里程碑建议（顺序执行）

1. M1（P1 完成）：检索链路对齐。
2. M2（P2+P3 完成）：压缩链路与 Hook 链路对齐。
3. M3（P4 完成）：可观测性与运维对齐。
4. M4（P5 完成）：全量验收报告通过，进入“完全对齐”状态。

---

本计划文件用于“完全对齐”实施主线，执行过程中请同步更新：
- `docs/implementation-status.md`
- `docs/acceptance-test-cases.md`
- `docs/compatibility-matrix.md`
