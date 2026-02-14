# CodexMem 验收用例（功能对齐 Claude-Mem）

## 1. 使用方式

本文是“可执行验收集”。每个用例包含：
- 前置条件
- 执行步骤
- 预期结果

建议执行顺序：A -> B -> C -> D -> E。

## 2. A 组：基础健康与契约

## A1 健康检查

前置条件：
- Worker 已启动

步骤：
1. `GET /api/health`
2. `GET /api/readiness`
3. `GET /api/version`

预期：
1. `health` 返回 200 且含 `initialized/mcpReady`
2. `readiness` 在初始化前 503，完成后 200
3. `version` 返回 semver 字符串

## A2 MCP 工具列表

步骤：
1. 调用 MCP `tools/list`

预期：
- 只包含 5 工具：`__IMPORTANT/search/timeline/get_observations/save_memory`

## 3. B 组：会话链路

## B1 初始化会话（幂等）

步骤：
1. `POST /api/sessions/init`（同一 `contentSessionId`）
2. 再次调用同参数

预期：
1. 两次返回同一个 `sessionDbId`
2. `promptNumber` 递增规则正确（按 user_prompts 计数）

## B2 私密 prompt 跳过

步骤：
1. init prompt 使用 `<private>secret</private>`

预期：
- 返回 `skipped=true, reason=private`
- `user_prompts` 不保存可见文本

## B3 Observation 入队

步骤：
1. 调 `/api/sessions/observations`，传正常 tool payload

预期：
- 返回 `status=queued`
- `pending_messages` 新增一条 `message_type=observation`

## B4 Summarize 入队

步骤：
1. 调 `/api/sessions/summarize`

预期：
- 返回 `status=queued`
- `pending_messages` 新增 `message_type=summarize`

## B5 Complete 语义

步骤：
1. 调 `/api/sessions/complete`
2. 再调一次

预期：
1. 第一次：`status=completed`
2. 第二次：`status=skipped` 或幂等成功

## 4. C 组：队列可靠性与恢复

## C1 claim -> store -> confirm

步骤：
1. 构造一条 pending message
2. 模拟消费器 claim 为 processing
3. 执行 store 成功
4. 执行 confirm

预期：
1. 仅在 store 成功后消息才删除/processed
2. observation/summary 数据与消息一致

## C2 中途崩溃恢复

步骤：
1. 消息进入 `processing` 后，故意终止 worker
2. 重启 worker，执行恢复流程

预期：
1. stale processing 重置回 pending
2. 消息被再次消费并最终成功
3. 不出现重复 observation（同一输入仅一份）

## C3 重试上限

步骤：
1. 连续制造处理失败 > maxRetries

预期：
- 消息最终进入 `failed`，不无限重试

## 5. D 组：搜索与读取

## D1 filter-only 搜索

步骤：
1. `GET /api/search?project=x&type=bugfix&dateStart=...&dateEnd=...`（不传 query）

预期：
- 走 SQLite 过滤路径
- 返回结果满足时间与类型过滤

## D2 query 语义检索

步骤：
1. `GET /api/search?query=authentication bug&limit=10`

预期：
- OpenAI key 可用时：返回 `Search mode: hybrid`，并看到语义召回与关键词结果的合并去重结果
- OpenAI key 不可用时：返回 `Search mode: lexical-only`，且接口仍正常可用（降级成功）

## D2.1 向量后端切换

步骤：
1. 设置 `CODEXMEM_VECTOR_BACKEND=sqlite`，执行同一 query
2. 设置 `CODEXMEM_VECTOR_BACKEND=chroma`（chroma 不可用时），执行同一 query
3. 设置 `CODEXMEM_VECTOR_BACKEND=hybrid`，执行同一 query

预期：
- sqlite/hybrid 在本地向量可用时正常返回
- chroma 不可用时降级但不返回 5xx
- 三种模式下接口契约一致

## D3 batch 详情校验

步骤：
1. `POST /api/observations/batch` with `{ids:[1,2]}`
2. `POST /api/observations/batch` with `{ids:["1"]}`

预期：
1. 第一条 200，返回数组
2. 第二条 400，报 ids 类型错误

## D4 save_memory 闭环

步骤：
1. MCP 调 `save_memory(text=..., title=...)`
2. MCP 调 `search(query=title关键词)`
3. MCP 调 `get_observations(ids=[返回ID])`

预期：
- 可检索、可回读、字段正确

## 6. E 组：兼容回归（对比 Claude-Mem）

## E1 同输入流对比

输入：
- 固定 30 条 hook 事件（init、多个 tool use、summarize、complete）

步骤：
1. 在 `claude-mem` 执行一遍，导出结果
2. 在 `codexmem` 执行一遍，导出结果
3. 对比统计与 Top-N 检索

预期：
1. observation 条数一致
2. type/project 分布一致
3. 关键查询 Top-N 召回率 >= 95%
4. 可使用 `bun run test:parity -- ...` 自动输出对比报告并给出通过/失败退出码

## E2 Hook 降级行为

步骤：
1. 关闭 worker，触发 hooks

预期：
- hooks 返回成功退出，不阻塞主会话流程

## 7. 通过标准

1. A/B/C/D 全量通过
2. E 组差异在允许阈值内
3. 无 P0 缺陷（消息丢失、重复、阻塞主流程）

## 8. 建议自动化脚本

1. `test:contract`：校验 API 响应 schema
2. `test:queue-recovery`：模拟崩溃恢复（当前已实现）
3. `test:mcp-e2e`：MCP 5 工具全链路
4. `test:parity`：对比 `claude-mem` 基线结果
5. `test:release-gate`：聚合 parity + benchmark + soak 的统一发布门禁
6. `test:quality-replay`：质量回放（agent 失败分类与成功率）
7. `test:t2-convergence`：真实基线连续收敛（多轮门禁 + 趋势守护）

当前状态：
- `test:contract` 已实现（基础 HTTP 契约回归）
- `test:queue-recovery` 已实现
- `test:mcp-e2e` 已实现（MCP 5 工具全链路）
- `test:hook-matrix` 已实现（3 平台 × 4 事件 + worker 不可用降级）
- `test:sse` 已实现（SSE 订阅 + 运维接口可用性）
- `test:parity` 已实现
- `test:benchmark` 已实现（search/batch P95 基准）
- `test:soak` 已实现（长稳压测 + 内存采样报告）
- `test:release-gate` 已实现（统一门禁报告 + 退出码）
- `test:quality-replay` 已实现（质量回放与成功率门禁）
- `test:t2-convergence` 已实现（连续通过与回退趋势判定）
- `backfill:chroma` 已实现（P1 向量回填）
