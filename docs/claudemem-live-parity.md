# ClaudeMem 实时功能对齐验证

## 1. 目标

在同一台机器上同时运行 `claude-mem` 与 `codexmem`，用统一请求集做实时能力对比，验证：

1. 基础健康接口可用：`health/readiness/version`
2. 核心能力可用：`memory/save`、`observations`、`observation/:id`、`search`、`timeline`、`context/inject`
3. 结果规模无明显偏差（观测条数、search 命中数）

## 2. 运行方式

```bash
cd /Users/zzz/fun/mem/codexmem
bun run test:claudemem-live-parity -- \
  --claude-url http://127.0.0.1:37888 \
  --codex-url http://127.0.0.1:37777 \
  --output ./artifacts/parity/live-parity-report.json
```

默认参数：

1. `--claude-url`：`http://127.0.0.1:37888`
2. `--codex-url`：`http://127.0.0.1:37777`
3. `--project`：`live-parity`（脚本内部会自动加时间戳）

## 3. 通过判定

脚本返回码：

1. `0`：通过
2. `1`：不通过

通过条件：

1. 双端所有检查项 `ok=true`
2. observation 数量差 `<= 1`
3. search 命中差 `<= 2`

## 4. 报告结构

输出 JSON 含：

1. `claude.checks[]`：ClaudeMem 各检查项状态
2. `codex.checks[]`：CodexMem 各检查项状态
3. `compare.notes[]`：差异说明
4. `passed`：最终结论

## 5. 说明

该脚本采用“模型无关”检查集，重点验证协议与功能链路，而不是比较模型生成文本内容本身。

