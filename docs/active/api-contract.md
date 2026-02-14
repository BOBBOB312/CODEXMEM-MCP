# CodexMem API 与 MCP 契约（对齐 Claude-Mem）

## 1. 目标

本文定义 `codexmem` 需要实现的 MCP 工具契约与 Worker HTTP 契约，目标是与 `claude-mem` 语义对齐，可直接作为开发与测试依据。

## 2. MCP 契约

## 2.1 tools/list

必须返回以下工具名：
- `__IMPORTANT`
- `search`
- `timeline`
- `get_observations`
- `save_memory`

## 2.2 tools/call: `__IMPORTANT`

输入：
- 空对象或任意对象（忽略参数）

输出：
- `content[0].type = "text"`
- 文本内容必须明确 3 层工作流：
1. `search`
2. `timeline`
3. `get_observations`

## 2.3 tools/call: `search`

输入参数（兼容）：
- `query?: string`
- `limit?: number`
- `offset?: number`
- `project?: string`
- `type?: string | string[]`（`observations/sessions/prompts` 或 observation type 过滤）
- `obs_type?: string | string[]`
- `concepts?: string | string[]`
- `files?: string | string[]`
- `dateStart?: string|number`
- `dateEnd?: string|number`
- `orderBy?: "relevance"|"date_desc"|"date_asc"`
- `format?: "json"`

行为：
- 有 `query` 时走语义检索（按 `CODEXMEM_VECTOR_BACKEND` 选择 `sqlite/chroma/hybrid`）
- 无 `query` 时走 SQLite 过滤查询
- `format=json` 返回结构化 JSON，否则返回 markdown 文本

错误：
- 向量检索不可用时返回可读错误文本，不抛协议级异常

## 2.4 tools/call: `timeline`

输入参数：
- `anchor?: number|string`
- `query?: string`
- `depth_before?: number`
- `depth_after?: number`
- `project?: string`

行为：
- 优先用 `anchor`
- 无 `anchor` 且有 `query` 时自动选 anchor
- 返回按时间排序的上下文片段

## 2.5 tools/call: `get_observations`

输入参数：
- `ids: number[]`（必填）
- `orderBy?: "date_desc"|"date_asc"`
- `limit?: number`
- `project?: string`
- `type?: string|string[]`
- `concepts?: string|string[]`
- `files?: string|string[]`

行为：
- 调用 Worker `POST /api/observations/batch`
- `ids=[]` 返回空数组

错误：
- `ids` 非数组或存在非整数：返回 `isError=true` 与错误文本

## 2.6 tools/call: `save_memory`

输入参数：
- `text: string`（必填）
- `title?: string`
- `project?: string`

行为：
- 转发到 `POST /api/memory/save`
- 成功后返回写入 ID 与项目名

## 3. Worker HTTP 契约

## 3.1 健康与系统

1. `GET /api/health`
- 200，始终可用
- 最少字段：`status, version, initialized, mcpReady, pid, uptime`

2. `GET /api/readiness`
- 初始化完成前：503 + `status=initializing`
- 初始化完成后：200 + `status=ready`

3. `GET /api/version`
- 200 + `{ "version": "<semver>" }`

## 3.2 会话入口（hook 调用）

1. `POST /api/sessions/init`

请求：
```json
{
  "contentSessionId": "string",
  "project": "string",
  "prompt": "string"
}
```

响应：
```json
{
  "sessionDbId": 123,
  "promptNumber": 1,
  "skipped": false
}
```

私密 prompt（被剥离为空）：
```json
{
  "sessionDbId": 123,
  "promptNumber": 1,
  "skipped": true,
  "reason": "private"
}
```

2. `POST /api/sessions/observations`

请求：
```json
{
  "contentSessionId": "string",
  "tool_name": "Read",
  "tool_input": {},
  "tool_response": {},
  "cwd": "/path"
}
```

响应：
- 入队成功：`{ "status": "queued" }`
- 重复事件：`{ "status": "deduped" }`
- 跳过工具：`{ "status": "skipped", "reason": "tool_excluded" }`
- 私密会话：`{ "status": "skipped", "reason": "private" }`

3. `POST /api/sessions/summarize`

请求：
```json
{
  "contentSessionId": "string",
  "last_assistant_message": "string"
}
```

响应：
- `{"status":"queued"}` 或 `{"status":"deduped"}` 或 `{"status":"skipped","reason":"private"}`

4. `POST /api/sessions/complete`

请求：
```json
{
  "contentSessionId": "string"
}
```

响应：
- `{"status":"completed","sessionDbId":123}`
- 非活动会话：`{"status":"skipped","reason":"not_active"}`

## 3.3 搜索与读取

1. `GET /api/search`
- 查询参数同 MCP `search`
- 返回 MCP 可直接转发的数据结构（文本或 JSON 包）

2. `GET /api/timeline`
- 查询参数同 MCP `timeline`

3. `POST /api/observations/batch`

请求：
```json
{
  "ids": [1, 2, 3],
  "orderBy": "date_desc",
  "limit": 20,
  "project": "demo"
}
```

响应：Observation 数组

错误：
- 非数组：400 `ids must be an array of numbers`
- 非整数：400 `All ids must be integers`

4. `GET /api/observation/:id`
- 404: `Observation #<id> not found`

5. `GET /api/observations`
6. `GET /api/summaries`
7. `GET /api/prompts`
8. `GET /api/projects`
9. `GET /api/stats`
10. `GET /api/processing-status`

## 3.4 手动记忆

`POST /api/memory/save`

请求：
```json
{
  "text": "API 需要 X-API-Key",
  "title": "Auth",
  "project": "my-app"
}
```

响应：
```json
{
  "success": true,
  "id": 1001,
  "title": "Auth",
  "project": "my-app",
  "message": "Memory saved as observation #1001"
}
```

错误：
- 缺失或空文本：400 `text is required and must be non-empty`

## 3.5 SSE 与运维接口

1. `GET /api/events`
- Server-Sent Events 流，事件类型：
  - `queue.depth`
  - `session.status`
  - `queue.failed`
  - `model.result`

2. `GET /viewer`
- 高级 Viewer 页面，展示：
  - 队列计数与 SSE 实时流
  - search trace
  - session 处理耗时分解
  - 失败分类聚合与最近失败明细
  - 趋势面板（search/queue/failure）
  - 交互过滤与导出链接

3. `GET /api/ops/index-status`
- 返回向量后端模式、SQLite embedding 计数、Chroma 配置状态

4. `GET /api/ops/agent-metrics`
- 返回 agent 质量计数（按 `observation/summary`）：
  - `success`
  - `parse_fail`
  - `schema_fail`
  - `repair_fail`
  - `fallback_used`

5. `POST /api/ops/agent-metrics/reset`
- 重置上述计数器

6. `POST /api/ops/retry-failed`
- 请求：`{ "sessionDbId"?: number }`
- 响应：`{ "success": true, "retried": <number> }`

7. `POST /api/ops/backfill/chroma`
- 请求：`{ "project"?: string, "limit"?: number }`
- 响应：`{ "success": true, "observations": n, "summaries": n, "prompts": n, "skipped": boolean }`

8. `GET /api/ops/search-traces`
- 查询参数：
  - `limit?: number`
  - `query?: string`
  - `project?: string`
  - `mode?: "lexical-only" | "hybrid"`
  - `from?: epochSec|epochMs|ISODate`
  - `to?: epochSec|epochMs|ISODate`
- 返回最近搜索追踪（query、mode、vector 命中来源、耗时、结果规模）

9. `GET /api/ops/session-timings`
- 查询参数：
  - `limit?: number`
  - `sessionDbId?: number`
  - `messageType?: "observation" | "summarize"`
  - `success?: boolean`
  - `from?: epochSec|epochMs|ISODate`
  - `to?: epochSec|epochMs|ISODate`
- 返回逐消息耗时分解（queueWait/model/index/total）与聚合平均值

10. `GET /api/ops/failure-summary`
- 查询参数：
  - `limit?: number`
  - `sessionDbId?: number`
  - `errorClass?: string`
  - `messageType?: "observation" | "summarize"`
  - `from?: epochSec|epochMs|ISODate`
  - `to?: epochSec|epochMs|ISODate`
- 返回失败分类聚合（errorClass -> count）与最近失败详情

11. `GET /api/ops/search-traces/export`
- 查询参数同 `GET /api/ops/search-traces`，额外：
  - `format?: "csv" | "ndjson"`（默认 `csv`）

12. `GET /api/ops/session-timings/export`
- 查询参数同 `GET /api/ops/session-timings`，额外：
  - `format?: "csv" | "ndjson"`（默认 `csv`）

13. `GET /api/ops/failure-summary/export`
- 查询参数同 `GET /api/ops/failure-summary`，额外：
  - `format?: "csv" | "ndjson"`（默认 `csv`）

14. `GET /api/ops/trends`
- 查询参数：
  - `windowSec?: number`（默认 3600，范围 60~86400）
  - `bucketSec?: number`（默认 60，范围 10~3600）
- 返回按 bucket 聚合的趋势序列：
  - `searchCount`, `avgSearchMs`
  - `queueCount`, `avgQueueTotalMs`
  - `failureCount`

## 4. 错误语义规范

1. 400：参数错误、校验失败
2. 404：资源不存在
3. 503：服务初始化中
4. 500：服务内部错误

约束：
- Hook 入口在 Worker 不可用时应“降级成功”，不阻断主流程
- MCP 层错误尽量转为 `isError + content[text]`，避免协议崩溃

## 5. Hook CLI 契约（Phase 2）

命令：
```bash
bun run hook <platform> <event>
```

平台：
- `claude-code`
- `cursor`
- `raw`

事件：
- `session-init`
- `observation`
- `summarize`
- `session-complete`

行为：
- 从 stdin 读取 JSON 输入并做平台字段归一化
- 调用 Worker 对应 API
- Worker 不可用时返回成功降级（exit code 0）

## 6. Provider 契约（Codex 场景）

`codexmem` 在 Codex 场景默认仅使用 OpenAI 模型：
- `CODEXMEM_PROVIDER=openai`（默认）
- `CODEXMEM_OPENAI_MODEL`
- `CODEXMEM_OPENAI_BASE_URL`
- `OPENAI_API_KEY` / `CODEXMEM_OPENAI_API_KEY`
- `CODEXMEM_VECTOR_BACKEND=sqlite|chroma|hybrid`
- `CODEXMEM_CHROMA_URL`
- `CODEXMEM_CHROMA_COLLECTION`
- `CODEXMEM_OPENAI_EMBEDDING_MODEL`
- `CODEXMEM_OPENAI_EMBEDDING_BASE_URL`（可选，默认继承 `CODEXMEM_OPENAI_BASE_URL`）
- `CODEXMEM_OPENAI_EMBEDDING_API_KEY`（可选，默认继承 `CODEXMEM_OPENAI_API_KEY`）

行为约束：
- OpenAI 调用失败或缺少 key 时，自动回退到 `rule-based`，保证队列可继续处理。
- embedding 配置缺失时，语义检索自动降级为 `lexical-only`，不影响主流程。
