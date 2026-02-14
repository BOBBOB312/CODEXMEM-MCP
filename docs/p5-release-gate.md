# P5 发布门禁流水线（最终对齐验收）

## 1. 目标

P5 目标是提供一个“可重复执行”的发布门禁流程，自动汇总：

1. 对齐：Top-N 召回率、条数偏差、分布偏差
2. 性能：`search P95`、`batch P95`
3. 稳定：长稳压测（RSS 增长、失败采样）

并输出单一 `passed=true/false` 结论。

## 2. 新增脚本

1. `scripts/replay-events.ts`
- 用固定事件流回放到 Worker
- 导出 candidate 工件：
  - `candidate-observations.json`
  - `candidate-search.json`
  - `event-results.json`

2. `scripts/release-gate.ts`
- 串联执行：
  - `scripts/parity-report.ts`
  - `scripts/benchmark.ts`
  - `scripts/soak.ts`
- 输出统一报告并返回发布门禁退出码：
  - `0`：通过
  - `1`：未通过
  - `2`：参数错误

## 3. 固定输入样例

- 事件流样例：`fixtures/p5/replay-events.sample.json`
- 查询样例：`fixtures/p5/search-queries.sample.json`

说明：
- 该样例用于演示回放与门禁流程。
- 真实发布请替换为与你们生产数据集一致的固定基线。

## 4. 标准执行流程

## 4.1 生成 candidate 工件

确保 Worker 已启动（例如 `bun run worker`），然后执行：

```bash
bun run replay:events -- \
  --events ./fixtures/p5/replay-events.sample.json \
  --queries ./fixtures/p5/search-queries.sample.json \
  --out-dir ./artifacts/p5/candidate
```

## 4.2 准备 baseline 工件

从 claude-mem 导出以下文件并放置到目录（示例）：

- `./artifacts/p5/baseline/observations.json`
- `./artifacts/p5/baseline/search.json`

## 4.3 执行统一发布门禁

```bash
bun run test:release-gate -- \
  --baseline-observations ./artifacts/p5/baseline/observations.json \
  --candidate-observations ./artifacts/p5/candidate/candidate-observations.json \
  --baseline-search ./artifacts/p5/baseline/search.json \
  --candidate-search ./artifacts/p5/candidate/candidate-search.json \
  --output ./artifacts/p5/release-gate-report.json
```

## 5. 常用参数

1. 对齐阈值
- `--min-recall`（默认 `0.95`）
- `--max-count-delta-ratio`（默认 `0.05`）
- `--max-project-dist-delta-ratio`（默认 `0.2`）
- `--max-type-dist-delta-ratio`（默认 `0.2`）

2. 性能阈值
- `--search-p95-max`（默认 `300` ms）
- `--batch-p95-max`（默认 `500` ms）

3. 稳定性阈值
- `--soak-duration-sec`（默认 `86400`，24h）
- `--soak-interval-sec`（默认 `10`）
- `--soak-max-rss-growth-kb`（默认 `262144`，256MB）

4. 本地快速验证
- `--skip-soak`（跳过长稳压测，仅用于开发阶段快速回归）

## 6. 报告结构

`release-gate` 报告包含：

1. `thresholds`：当前门禁阈值
2. `parity`：召回、条数偏差、分布偏差
3. `benchmark`：`searchP95`、`batchP95`
4. `soak`：长稳采样结果（或 `skipped`）
5. `passed`：最终门禁结论
