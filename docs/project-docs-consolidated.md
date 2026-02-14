# CodexMem Documentation Consolidated Guide

## 1. Purpose

This document consolidates the current stage-based documentation into one practical guide for engineering, operations, and release.

Use this file as the primary entrypoint. Stage documents can remain as historical records.

## 2. Current System Snapshot

- Project: `codexmem`
- Core mode: MCP-connected automatic memory
- Runtime chain: `session-init -> observation -> summarize -> session-end(cleanup)`
- Default stack:
  - Worker API + MCP server + codex bridge
  - SQLite storage
  - Vector backend: `sqlite/chroma/hybrid`
  - Provider: OpenAI-compatible (with rule-based fallback)

## 3. What The System Does

1. Captures session events from Codex session logs.
2. Converts tool executions into queued observations.
3. Compresses observation/summary via agent pipeline.
4. Stores structured memory into SQLite.
5. Builds/reuses vector index for retrieval.
6. Exposes memory via MCP tools and HTTP APIs.
7. Tracks ops metrics/traces and supports release gates.
8. Applies retention policy (TTL + soft delete + delayed hard delete).

## 4. Source of Truth (Keep These As Primary)

1. `docs/api-contract.md`
- MCP + Worker contract definitions.
- Keep as interface authority.

2. `docs/data-schema.md`
- Data model and migration rules.
- Keep as storage authority.

3. `docs/session-state-machine.md`
- Session/queue lifecycle semantics.
- Keep as runtime behavior authority.

4. `docs/implementation-status.md`
- Current implemented surface and latest status.
- Keep as operations snapshot.

5. `docs/codex-auto-memory.md`
- Codex auto-memory runtime and bridge behavior.
- Keep as deployment/operations guide.

## 5. Stage Docs Status (Useful or Not)

These are still useful, but mainly for history, audit, and rationale:

- `docs/claude-mem-to-codexmem-mcp-migration.md`
  - Value: migration baseline and equivalence goals.
  - Status: historical reference.

- `docs/compatibility-matrix.md`
  - Value: capability-by-capability alignment checklist.
  - Status: historical + periodic regression reference.

- `docs/full-parity-implementation-plan.md`
  - Value: phased implementation strategy.
  - Status: historical (most items completed).

- `docs/final-parity-gap-closure.md`
  - Value: gap analysis and closure tasks.
  - Status: historical, useful for postmortem.

- `docs/acceptance-test-cases.md`
  - Value: executable acceptance scenarios.
  - Status: still active for QA/regression.

- `docs/claudemem-live-parity.md`
  - Value: live parity validation procedure.
  - Status: still active when parity must be re-verified.

- `docs/p5-release-gate.md`
- `docs/t2-baseline-convergence.md`
- `docs/t4-release-workflow.md`
  - Value: release quality gate and convergence workflow.
  - Status: active in release engineering.

## 6. Recommended Documentation Policy

1. Keep all existing docs for now (no deletion).
2. Treat this file as top-level index and decision map.
3. In future updates:
- Update `implementation-status.md` first.
- Update `api-contract.md` and `data-schema.md` when behavior/schema changes.
- Only update stage docs if release process changes.

## 7. If You Want a Cleaner Docs Folder

Suggested optional next step:

1. Keep active docs in root `docs/`:
- `api-contract.md`
- `data-schema.md`
- `session-state-machine.md`
- `implementation-status.md`
- `codex-auto-memory.md`
- `project-docs-consolidated.md`

2. Move historical stage docs to `docs/archive/`:
- migration, parity plans, phased closure notes

3. Keep release-runbook docs either in root or `docs/release/`:
- `p5-release-gate.md`
- `t2-baseline-convergence.md`
- `t4-release-workflow.md`

## 8. Quick Navigation

- Need API behavior: `docs/api-contract.md`
- Need schema changes: `docs/data-schema.md`
- Need queue/session semantics: `docs/session-state-machine.md`
- Need current implemented scope: `docs/implementation-status.md`
- Need Codex auto-memory operations: `docs/codex-auto-memory.md`
- Need release process: `docs/p5-release-gate.md`, `docs/t2-baseline-convergence.md`, `docs/t4-release-workflow.md`

