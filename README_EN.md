# CodexMem

Chinese documentation: `README_ZH.md`

CodexMem is a persistent memory service for Codex/MCP workflows. It captures high-signal session events, processes them asynchronously, and stores structured memories that can be reused across sessions.

Project goals:
- Enable fully automatic background memory after MCP connection in Codex App.
- Align core mechanisms and lifecycle semantics with ClaudeMem.
- Provide production-oriented observability, regression tests, and release gates.

## Core Features

- Automatic memory lifecycle (enabled by default): `session-init -> observation -> summarize -> session-end(cleanup)`.
- Multi-platform hook adapters: `claude-code`, `cursor`, `codex`, `raw`.
- MCP tools: `__IMPORTANT`, `search`, `timeline`, `get_observations`, `save_memory`.
- Vector retrieval backends: `sqlite`, `chroma`, `hybrid`.
- Queue idempotency and recovery: `pending/processing/failed` state machine + dedupe.
- Observability: SSE stream, Viewer dashboard, search/latency traces, failure summaries, trend exports.
- Retention policy: project-level TTL cleanup with soft-delete + delayed hard-delete + dry-run.

## Architecture

- `src/worker/server.ts`: Worker API and queue processing core.
- `src/mcp/server.ts`: MCP stdio server for tool exposure.
- `src/cli/codex-bridge.ts`: Watches `~/.codex/sessions/**/*.jsonl` and bridges to Worker events.
- `src/db/store.ts`: SQLite storage layer (sessions, observations, summaries, queue, vectors, retention policies).

Flow:
1. Codex session emits events (user prompt, tool calls, session end).
2. Bridge forwards events to Worker APIs.
3. Worker enqueues observation/summarize jobs and processes them asynchronously.
4. Agent generates structured memory and writes/indexes data.
5. MCP retrieval tools serve cross-session memory queries.

## Quick Start

### 1) Install dependencies

```bash
cd /Users/zzz/fun/mem/codexmem
bun install
```

### 2) Start (recommended)

```bash
bun run mcp
```

Notes:
- MCP checks Worker health first.
- If Worker is unavailable, MCP auto-starts Worker.
- Once Worker is ready, MCP auto-starts `codex-bridge` for background memory.

### 3) Codex App MCP config example

Config file: `/Users/zzz/.codex/config.toml`

```toml
[mcp_servers.codexmem]
command = "zsh"
args = [ "-lc", "cd /Users/zzz/fun/mem/codexmem && bun run mcp" ]
```

## Common Commands

- Start Worker: `bun run worker`
- Start MCP: `bun run mcp`
- Start bridge only: `bun run codex:auto-memory`
- Hook example: `echo '{"session_id":"sess-1","cwd":"/tmp","prompt":"hello"}' | bun run hook codex session-init`
- Type check: `bun run check`
- Run all tests: `bun test`

## Configuration

Config file: `~/.codexmem/settings.json`

### Basic

- `CODEXMEM_WORKER_HOST` (default `127.0.0.1`)
- `CODEXMEM_WORKER_PORT` (default `37777`)
- `CODEXMEM_MCP_ENABLED` (default `true`)
- `CODEXMEM_PROVIDER` (default `openai`)

### Model (OpenAI-compatible)

- `CODEXMEM_OPENAI_MODEL` (default `gpt-4o-mini`)
- `CODEXMEM_OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`)
- `CODEXMEM_OPENAI_BASE_URL`
- `CODEXMEM_OPENAI_API_KEY`
- `CODEXMEM_OPENAI_EMBEDDING_BASE_URL` (optional, inherits main base URL if empty)
- `CODEXMEM_OPENAI_EMBEDDING_API_KEY` (optional, inherits main API key if empty)

### Vector Search

- `CODEXMEM_VECTOR_BACKEND`: `sqlite | chroma | hybrid`
- `CODEXMEM_CHROMA_URL`
- `CODEXMEM_CHROMA_COLLECTION`

### Automation and Stability

- `CODEXMEM_SKIP_TOOLS`
  - default: `ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion`
- `CODEXMEM_STALE_PROCESSING_MS`
- `CODEXMEM_AUTO_RECOVER_ON_BOOT` (default `false`)

### MCP Auto-bootstrap env flags

- `CODEXMEM_MCP_AUTO_BOOTSTRAP=false`: disable MCP auto-starting Worker
- `CODEXMEM_MCP_AUTO_BRIDGE=false`: disable MCP auto-starting bridge
- `CODEXMEM_MCP_STOP_WORKER_ON_EXIT=true`: stop Worker (spawned by MCP) when MCP exits

### Retention (TTL)

- `CODEXMEM_RETENTION_ENABLED` (default `true`)
- `CODEXMEM_RETENTION_TTL_DAYS` (default `30`)
- `CODEXMEM_RETENTION_SOFT_DELETE_DAYS` (default `7`)
- `CODEXMEM_RETENTION_SWEEP_INTERVAL_MIN` (default `1440`)

## API Overview

### Health

- `GET /api/health`
- `GET /api/readiness`
- `GET /api/version`

### Session & Memory

- `POST /api/sessions/init`
- `POST /api/sessions/observations`
- `POST /api/sessions/summarize`
- `POST /api/sessions/end`
- `POST /api/sessions/complete` (compat)
- `POST /api/memory/save`

### Query

- `GET /api/search`
- `GET /api/timeline`
- `GET /api/context/inject`
- `GET /api/observations`
- `GET /api/summaries`
- `GET /api/prompts`
- `GET /api/observation/:id`
- `POST /api/observations/batch`

### Ops

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

### Retention APIs

- `GET /api/ops/retention/policies`
- `POST /api/ops/retention/policies`
- `POST /api/ops/retention/cleanup`

## Retention Policy

Policy behavior:
- Expiration is based on `last_accessed_at`, not only creation time.
- Expired memories are soft-deleted first.
- Hard deletion happens after soft-delete grace period.
- Project policy supports `enabled`, `pinned`, and `ttlDays`.

Recommended practice:
1. Run `dry-run` first.
2. Execute real cleanup after validation.
3. Set `pinned=true` for critical projects.

## Testing

- Contract: `bun test tests/contract.test.ts`
- Hook matrix: `bun run test:hook-matrix`
- MCP E2E: `bun run test:mcp-e2e`
- Full suite: `bun test`

Release gates:
- Parity: `bun run test:parity`
- Benchmark: `bun run test:benchmark`
- Soak: `bun run test:soak`
- Release gate: `bun run test:release-gate`

## Troubleshooting

- MCP connected but no memory:
  - Check `GET /api/health`
  - Verify `codex-bridge` process is alive
  - Ensure tool events or idle session-end events are actually happening
- Unexpected memory reduction:
  - Verify retention config and cleanup executions
  - Use dry-run to inspect candidates
- Weak search recall:
  - Verify `CODEXMEM_VECTOR_BACKEND`
  - Verify embedding config and Chroma availability

## Docs Index

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

## Contributing

Issues and PRs are welcome. Please include:
- Reproduction steps
- Expected vs actual behavior
- Relevant logs and config snippets

## License

This project is licensed under the **MIT License**.

See: `/Users/zzz/fun/mem/codexmem/LICENSE`
