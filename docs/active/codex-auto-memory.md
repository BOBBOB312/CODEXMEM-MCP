# Codex 全自动后台记忆（Hook Bridge）

## 1. 目标

在 Codex 场景下补齐类似 ClaudeMem 的自动后台记忆机制：

1. 会话启动自动 `session-init`
2. 工具调用自动 `observation`
3. 会话空闲后自动 `summarize + session-end(cleanup)`

实现方式：
- 监听 `~/.codex/sessions/**/*.jsonl`
- 将 Codex 事件桥接为 Worker API 调用

脚本：
- `src/cli/codex-bridge.ts`

命令：
- `bun run codex:auto-memory`

## 2. 启动方式

推荐（只连 MCP，一步自动）：

```bash
cd /Users/zzz/fun/mem/codexmem
bun run mcp
```

说明：
- `bun run mcp` 会自动检测 worker，不可用时自动拉起；
- worker 就绪后自动拉起 `codex-bridge`，实现后台自动记忆。

手动模式（调试时使用）：

```bash
bun run worker
bun run codex:auto-memory
```

常用参数：

1. `--poll-ms`：轮询间隔（默认 1500）
2. `--idle-sec`：会话空闲多久后触发 summarize/session-end（默认 45）
3. `--sessions-dir`：Codex session 日志目录（默认 `~/.codex/sessions`）
4. `--state-file`：桥接状态文件（默认 `~/.codexmem/codex-bridge-state.json`）
5. `--once`：只执行一轮扫描（用于测试）

## 3. 事件映射

1. `response_item(message,user)` -> `POST /api/sessions/init`
2. `response_item(function_call + function_call_output)` -> `POST /api/sessions/observations`
3. `response_item(message,assistant,phase=final_answer)` 缓存最后回答
4. 空闲超过 `idle-sec` -> `POST /api/sessions/summarize` + `POST /api/sessions/end`（`cleanup=true`）
5. 若未捕获 `final_answer`，会使用兜底摘要文本触发 `summarize`，确保不会漏掉 `session-end` 前的记忆收口

## 4. 验证

```bash
bun run test:codex-bridge
```

该测试会模拟 Codex session 文件并校验四个 API 都被调用：

1. `/api/sessions/init`
2. `/api/sessions/observations`
3. `/api/sessions/summarize`
4. `/api/sessions/end`
