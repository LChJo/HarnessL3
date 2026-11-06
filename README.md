# HarnessL3 原型归档 v0.16

用户确认的Slate连线脑图原型的独立运行快照，分支为 `archive/prototype-v0.16`。包含原型源码、设计过程、终版截图、MGRP模型与7类20项技能；本机任务、日志和缓存不随Git分发。

本分支只运行原型；正式CLI在[正式首版分支](https://github.com/LChJo/HarnessL3/tree/codex/harnessl3-v1-20261106)维护。输入、五类上下文、输出和Skill Hub共享无限画布，逐层展开文件夹、技能与文件引用，历史/C4按需查看。

## 运行

需要Node.js24.12+的24.x、npm、Git，以及与示例证据匹配的MGRP来源工作区。来源路径仅存本机。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
$env:MGRP_SOURCE_ROOT = '你的MGRP工作区绝对路径'
$env:PORT = '4317'
New-Item -ItemType Directory -Force .harness-local | Out-Null
Set-Content -LiteralPath .harness-local/empty-rollout.jsonl -Value '' -Encoding utf8
$env:CODEX_ROLLOUT_PATH = (Resolve-Path .harness-local/empty-rollout.jsonl).Path
npm run build
npm start
```

打开所配置端口的本机页面。开发模式用 `npm run dev`；本分支build/start/test均指向原型，原build:prototype/start:prototype/test:prototype别名保留。空日志用于只看设计；观察真实工具记录时须显式指定获准读取的日志。原型的自动“最近日志”发现仍为历史局限。

## 资料与验证

- [最终设计与截图](docs/prototype/README.md)
- [运行与现有agent调用](docs/prototype/RUNNING.md)
- [此次归档复验](docs/prototype/ARCHIVE.md)
- [历史验证与局限](docs/prototype/VALIDATION.md)
- [归档基准](docs/PROJECT_BASELINE.md)
- [技能目录](skills/README.md)

运行 `npm test`、`npm run model:validate` 和 `npm run evidence:verify` 核验程序/模型/来源。浏览器命令见运行说明；它们会在此worktree创建自己的测试任务，技能检查会短暂增删自有测试技能。原有工作区的85条任务不复制到本分支。
