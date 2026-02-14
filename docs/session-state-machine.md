# CodexMem 会话与队列状态机（对齐 Claude-Mem）

## 1. 总览

`claude-mem` 的本质是“Hook 驱动 + 持久化队列 + 后台 agent 消费”。

要实现等价行为，`codexmem` 必须同时实现三套状态机：
1. 会话状态机（sdk_sessions）
2. 队列状态机（pending_messages）
3. worker 就绪状态机（health/readiness）

## 2. 会话状态机

状态：
- `active`
- `completed`
- `failed`

触发事件与转换：
1. `POST /api/sessions/init`
- 不存在会话：创建为 `active`
- 已存在：复用并保持 `active`

2. `POST /api/sessions/complete`
- 若在 active map 中：执行完成逻辑，转 `completed`
- 若不在 active map：返回 skipped，不强制改状态

3. 处理器异常且不可恢复
- 转 `failed`

约束：
- `content_session_id` 是外部稳定键
- `memory_session_id` 由 agent 首次有效响应后回填

## 3. 队列状态机

状态：
- `pending`
- `processing`
- `processed`（历史态，可选）
- `failed`

标准流程：
1. Hook 入站：`enqueue()` 写 `pending`
2. 消费器：`claim` 抢占，置 `processing`
3. 解析+存储成功：`confirmProcessed()` 删除或置 `processed`
4. 失败且可重试：回 `pending` 并 `retry_count+1`
5. 超过重试上限：置 `failed`

恢复流程：
1. Worker 启动：将 stale `processing` 重置到 `pending`
2. 扫描 `getSessionsWithPendingMessages()`
3. 为每个会话重启消费器

关键原则：
- 先持久化，再通知消费
- 先存储结果，再确认队列完成
- 不允许“已出队但未落库且不可恢复”

## 4. Hook -> API -> Queue 链路

1. `UserPromptSubmit`：
- 调 `/api/sessions/init`
- 调 `/sessions/:sessionDbId/init` 启动/确保 generator

2. `PostToolUse`：
- 调 `/api/sessions/observations`
- 会话侧做隐私检查与工具跳过
- 入队 observation

3. `Stop`：
- 调 `/api/sessions/summarize`
- 再调 `/api/sessions/complete`

## 5. 隐私与过滤规则（必须实现）

1. prompt/tool payload 进入存储前，剥离：
- `<private>...</private>`
- `<claude-mem-context>...</claude-mem-context>`

2. 如果清洗后 prompt 为空：
- `init` 返回 `skipped=true, reason=private`
- observation/summarize 跳过

3. 跳过低价值工具（配置驱动 `CODEXMEM_SKIP_TOOLS`）

## 6. Worker 状态机

状态：
- `liveness-ok`（health 可用）
- `initializing`（readiness 503）
- `ready`（readiness 200）

规则：
1. HTTP 监听成功后，`/api/health` 必须立即 200
2. DB/MCP 等后台初始化完成前，`/api/readiness` 必须 503
3. 初始化完成后，`/api/readiness` 切换 200

## 7. 异常处理语义

1. Hook 侧：
- Worker 不可达、timeout、5xx：降级成功（不阻塞主流程）
- 4xx 或代码错误：可视为阻断错误（便于暴露 bug）

2. Worker 侧：
- 参数错误：400
- 资源缺失：404
- 初始化中：503
- 系统异常：500

## 8. 幂等要求

1. `createSDKSession(contentSessionId, project, userPrompt)` 必须幂等。
2. `complete` 可重复调用，不应造成二次副作用。
3. 初始化/恢复逻辑可重复执行，结果一致。
