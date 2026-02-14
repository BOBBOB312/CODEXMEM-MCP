# CodexMem 最终补齐方案（对齐 ClaudeMem 同能力）

## 1. 目标

把当前“核心机制已对齐”的状态，提升为“能力与结果质量都对齐 ClaudeMem”。

完成标准：
1. 功能机制一致（已基本完成，继续守护）。
2. 结果质量一致（结构化抽取质量、检索召回稳定性达到目标）。
3. 证据链一致（真实基线 + 自动化门禁连续通过）。

## 2. 当前差距（必须补齐）

1. 压缩/抽取质量未完全同构  
- 当前 OpenAI 提示词与约束是轻量版。  
- 需要补齐到 ClaudeMem 生产级 prompt 结构与校验策略。

2. 真实基线收敛不足  
- 目前门禁脚本与样例链路已具备。  
- 但尚未在你们真实 ClaudeMem 基线上跑出“稳定通过”的长期结果。

3. 高级可观测性仍偏轻量  
- 现有 `/viewer` 为最小版。  
- 缺少 search trace、逐 session 耗时分解、失败分类聚合视图。

## 3. 执行 Todo（按优先级）

## T1：质量链路完全对齐（最高优先级）

状态：`已落地第一版（2026-02-14）`

1. 升级 Observation/Summary Prompt 模板到生产版结构（分层指令 + 少样本 + 负例约束）。
2. 增加字段级约束策略：
- 字段长度上限
- 枚举白名单
- 文本清洗规则统一
3. 增加失败分类指标：
- parse_fail
- schema_fail
- repair_fail
- fallback_used
4. 增加“质量回放集”：
- 至少 50 条真实事件流
- 对比 claude-mem/codexmem 的结构化输出一致性

已实现：
1. OpenAI Agent 分层 Prompt + few-shot + 负例约束。
2. schema 统一清洗与硬约束（长度、去重、白名单）。
3. 失败分类指标与接口：
- `success`
- `parse_fail`
- `schema_fail`
- `repair_fail`
- `fallback_used`
4. 质量回放脚本与 50 条样例：
- `scripts/quality-replay.ts`
- `fixtures/t1/quality-replay.events.json`

剩余收敛动作：
1. 用真实事件流替换样例回放集（至少 50 条）。
2. 在真实基线下把成功率与 fallback 使用率收敛到目标阈值。

验收标准：
1. 结构化解析成功率 >= 99%
2. schema violation = 0
3. fallback 使用率在阈值内（建议 < 5%）

## T2：真实基线对齐收敛

状态：`已落地执行链路（2026-02-14）`

1. 固化 baseline 工件目录规范：
- `artifacts/p5/baseline/observations.json`
- `artifacts/p5/baseline/search.json`
2. 使用同一回放输入生成 candidate：
- `replay:events` 产出候选工件
3. 连续执行门禁：
- 每轮执行 `test:release-gate`
- 记录报告趋势（recall、count delta、distribution delta）
4. 阈值收敛：
- recall >= 0.95
- 条数偏差 <= 5%
- 分布偏差 <= 20%

已实现：
1. 连续收敛脚本：`scripts/t2-convergence.ts`
2. 脚本能力：
- 每轮自动执行 `replay-events`
- 每轮自动执行 `release-gate`
- 聚合多轮报告并检查“连续通过 + 回退阈值”
3. 执行文档：`docs/t2-baseline-convergence.md`

剩余收敛动作：
1. 接入真实 baseline 工件（claude-mem 导出）。
2. 按真实数据执行至少 3 轮并达到连续通过。

验收标准：
1. 真实基线下连续 3 轮门禁通过
2. 任一关键指标无回退趋势

## T3：可观测性增强（高级 Viewer）

状态：`已完整落地（2026-02-14）`

1. 在 `/viewer` 增加 search trace 面板：
- query
- vector/lexical 合并策略
- 命中来源（sqlite/chroma）
2. 增加 session 处理耗时分解：
- queue wait
- model processing
- indexing
3. 增加失败聚合视图：
- 按 error class 聚合计数
- 最近 N 条失败详情

已实现（第二版）：
1. `/viewer` 新增三块高级面板：
- Search Trace
- Session Timings
- Failure Summary
 - Trends（search/queue/failure）
2. `/viewer` 新增交互能力：
- 按 query/project/mode/session/errorClass/from/to 过滤
- 一键导出 trace/timings/failure（CSV/NDJSON）
 - trends 折线图（search/queue/failure）
 - 趋势点位点击 drill-down（联动下方明细）
 - failure 突增告警高亮（last vs avg）
3. 新增运维接口：
- `GET /api/ops/search-traces`
- `GET /api/ops/session-timings`
- `GET /api/ops/failure-summary`
- `GET /api/ops/search-traces/export`
- `GET /api/ops/session-timings/export`
- `GET /api/ops/failure-summary/export`
- `GET /api/ops/trends`
4. 新增采集链路：
- `/api/search` 自动写入 trace（mode、vector 来源、耗时）
- `processSessionQueue` 自动写入耗时分解与失败分类记录

剩余增强动作：
1. 可选：趋势图支持多指标归一化/双轴切换。
2. 可选：drill-down 结果支持跨面板联动高亮与导出。

验收标准：
1. 可视化查看单次查询完整 trace
2. 可定位任意失败消息的分类与上下文

## T4：发布门禁落地到日常流程

1. 约定发布前强制执行：
- `bun run test`
- `bun run test:release-gate`（生产阈值，不跳过 soak）
2. 归档报告：
- 输出到 `artifacts/p5/reports/<date>/`
3. 失败处理规范：
- 任一门禁失败即阻断发布
- 必须在报告中记录修复与复测结果

验收标准：
1. 最近一次发布有完整门禁报告
2. 报告可追溯到具体输入与阈值配置

状态：`已落地（2026-02-14）`

已实现：
1. 新增统一工作流脚本：`scripts/t4-release-workflow.ts`
2. 新增命令入口：`bun run test:t4-release-workflow -- ...`
3. 自动归档目录：`artifacts/p5/reports/<timestamp>/`
4. 自动产出：
- `summary.json`
- `test.log`
- `release-gate.log`
- `release-gate-report.json`
- `remediation.md`（仅失败时）

## 4. 建议实施顺序

1. 先做 T1（质量链路）
2. 然后做 T2（真实基线收敛）
3. 再做 T3（高级可观测）
4. 最后固定 T4（发布制度化）

## 5. 最终“完全对齐”判定

满足以下全部条件，才标记为“完全对齐 ClaudeMem”：

1. 机制对齐：现有 P1-P5 全通过（已具备）。
2. 质量对齐：T1 指标全部达标。
3. 基线对齐：T2 连续 3 轮通过。
4. 可观测对齐：T3 可定位问题闭环。
5. 发布门禁对齐：T4 纳入发布流程并执行留档。

## 6. 最新对齐结论（2026-02-14）

状态：`功能层完全对齐（已验证）`

验证证据：
1. 全量回归通过：`bun test`（35 pass / 0 fail）
2. 关键链路通过：
- `test:hook-matrix`
- `test:sse`
- `test:contract`
- `test:mcp-e2e`
3. 新增跨仓库实时对齐脚本：
- `bun run test:claudemem-live-parity -- --claude-url http://127.0.0.1:37888 --codex-url http://127.0.0.1:37777 --output ./artifacts/parity/live-parity-report.json`
- 最新报告：`artifacts/parity/live-parity-report.json`
- 结果：`passed=true`

备注：
1. 该结论针对“功能能力对齐”（协议、接口、工具链路、可观测、发布流程）。
2. 模型质量阈值建议继续用真实生产 baseline 做周期性收敛复验。
