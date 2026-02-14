# T2 真实基线收敛执行指南

## 1. 目标

将“单次门禁可通过”提升为“真实基线连续稳定通过”。

通过标准：
1. 连续 3 轮 `release-gate` 通过。
2. 关键指标无明显回退趋势：
- recall 不回退超过阈值
- search P95 / batch P95 不明显恶化

## 2. 新增脚本

`scripts/t2-convergence.ts`

功能：
1. 每轮先执行 `replay-events` 生成 candidate 工件
2. 再执行 `release-gate` 产出该轮报告
3. 聚合多轮结果并检查：
- 连续通过次数
- 指标回退阈值

退出码：
1. `0`：达到连续通过要求
2. `1`：未达到
3. `2`：参数错误

## 3. 输入准备

1. 回放输入
- `--events <events.json>`
- `--queries <queries.json>`

2. ClaudeMem 基线
- `--baseline-observations <file>`
- `--baseline-search <file>`

## 4. 推荐命令

```bash
bun run test:t2-convergence -- \
  --events ./fixtures/p5/replay-events.sample.json \
  --queries ./fixtures/p5/search-queries.sample.json \
  --baseline-observations ./artifacts/p5/baseline/observations.json \
  --baseline-search ./artifacts/p5/baseline/search.json \
  --base-url http://127.0.0.1:37777 \
  --rounds 3 \
  --required-consecutive-pass 3 \
  --max-recall-regression 0.01 \
  --max-search-p95-regression 50 \
  --max-batch-p95-regression 50 \
  --output ./artifacts/t2/t2-convergence-report.json
```

本地快速回归可加：
- `--skip-soak`

## 5. 报告解读

输出报告包含：
1. `summary.consecutivePass`：最终连续通过轮数
2. `summary.passed`：是否达标
3. `rounds[]`：每轮 `gatePass/trendPass/roundPass` 与关键指标变化

判定建议：
1. 若 `gatePass` 失败：先看该轮 `release-gate` 的 parity/benchmark/soak 子报告。
2. 若 `trendPass` 失败：关注是否出现性能回退或召回回退。
