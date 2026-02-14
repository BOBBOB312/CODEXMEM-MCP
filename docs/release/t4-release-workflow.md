# T4 发布门禁制度化落地

## 1. 目标

将发布前检查固化为单命令工作流，满足：

1. 强制执行测试与门禁（`bun test` + `release-gate`）。
2. 报告自动归档到 `artifacts/p5/reports/<timestamp>/`。
3. 失败时自动生成修复复测记录模板，保证可追溯。

## 2. 脚本

- `scripts/t4-release-workflow.ts`
- 命令入口：`bun run test:t4-release-workflow -- ...`

## 3. 标准执行

```bash
bun run test:t4-release-workflow -- \
  --baseline-observations ./artifacts/p5/baseline/observations.json \
  --candidate-observations ./artifacts/p5/candidate/candidate-observations.json \
  --baseline-search ./artifacts/p5/baseline/search.json \
  --candidate-search ./artifacts/p5/candidate/candidate-search.json
```

可选参数：

1. `--reports-root`：报告根目录（默认 `./artifacts/p5/reports`）
2. `--run-tests true|false`：是否执行 `bun test`（默认 `true`）
3. `--skip-soak true|false`：是否跳过 soak（默认 `false`，发布建议禁用）
4. `--min-recall` / `--search-p95-max` / `--batch-p95-max`：关键阈值

## 4. 归档产物

每次执行生成：

1. `summary.json`：总览（输入、阈值、步骤退出码、最终 passed）
2. `test.log`：`bun test` 日志（若启用）
3. `release-gate.log`：门禁执行日志
4. `release-gate-report.json`：门禁完整结构化报告
5. `remediation.md`（仅失败时生成）：修复与复测记录模板

## 5. 发布判定

1. `bun test` 失败：阻断发布
2. `release-gate` 失败：阻断发布
3. 仅当 `summary.json.passed=true` 才可进入发布

## 6. 验收标准

1. 最近一次发布目录下存在完整归档（至少 `summary.json` + `release-gate-report.json`）。
2. 任一失败执行都有 `remediation.md`，并填写修复与复测结论。
3. 可从归档文件回溯输入工件路径与阈值配置。

