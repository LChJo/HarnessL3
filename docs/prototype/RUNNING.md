# 运行已冻结的原型

本归档分支可独立运行冻结的MGRP原型，默认build/start/test指向原型。原工作区此前的4317/4318进程已经停止，归档不复用其进程或任务。正式实现另见[CLI使用说明](https://github.com/LChJo/HarnessL3/blob/codex/harnessl3-v1-20261106/docs/USAGE.md)，二者不能混用。

## 启动

原型原最低Node.js为22.22.3；当前仓库正式工程限定Node24 LTS，本机核对版本24.12.0。

```powershell
npm ci
$env:MGRP_SOURCE_ROOT = 'I:\moonton\mftools\mgrp'
npm run dev
```

默认监听127.0.0.1:4317，PORT可调整端口，命令与服务须使用相同环境。生产模式使用npm run build后npm start；原build:prototype/start:prototype别名仍可用。只看设计时按[根README](../../README.md)配置显式空日志，避免自动发现其它会话。本分支不包含正式bin/harnessl3。

本机来源也可保存在忽略的`.harness-local/source.json`，字段为`sourceRoot`。业务源码仅作为只读演示来源；不要在其它机器假定该路径存在。参考[示例主模型](../../examples/mgrp/model/01-project.c4)与[证据引用](../../examples/mgrp/evidence.json)。

## 现有agent主动调用

```powershell
npm run harness -- start --title '排查下载取消后仍继续传输'
npm run harness -- select <task-id> --file <selection.json>
npm run harness -- handoff <task-id>
npm run harness -- read <task-id> --skill quality/tdd --path SKILL.md
```

必须先启动服务。start返回实际顶层简述、Skill Hub提示与轻目录；当前agent决定一次集合并提交，不是CLI启动模型。原型请求字段见[冻结的调用设计](archive/skill-routing.md)。

局部读取与历史可使用：

```powershell
node scripts/context.mjs query <task-id> --expand mgrp.execution,mgrp.network
node scripts/context.mjs query <task-id> --read mgrp.execution.task,mgrp.network
node scripts/context.mjs history --query '下载' --limit 20 --offset 0
node scripts/context.mjs show <task-id> --batch <batch-id>
```

这些是原型命令，不能与正式命令族混用。新读取要求原型任务绑定的模型版本仍有效；历史查看只读、不能续期。

## 技能与复现检查

技能是[仓库中的普通文件](../../skills/README.md)。原型默认skills/；可用`HARNESS_SKILLS_ROOT`或忽略的`.harness-local/skills.json`的root配置。自动更新和“刷新技能目录”不改用户正文或已存方案。

```powershell
npm run test:prototype
npm run test:context
npm run test:browser
npm run test:history
npm run test:skills
npm run model:validate
npm run evidence:verify
```

集成检查会创建本机测试任务、截图与报告，技能集成还会临时增删自有测试技能；只在独立worktree运行。test:runtime是要求真实Codex读写及脚本事件的历史审查脚本，本次空日志设计复验不运行，也不伪造事件使其通过。历史证据保留在assets/和validation/，新结果见[归档记录](ARCHIVE.md)，局限见[历史验证](VALIDATION.md)。

不要把model:generate作为普通刷新命令；它是首次引导脚本，默认拒绝覆盖已有模型，--force会显式重建。直接维护.c4后用model:validate核对即可。
