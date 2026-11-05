# 运行已冻结的原型

这里仅保存MGRP原型的历史运行方式。2026-11-06已停止此前原型进程，4317/4318均不再作为产品入口。正式实现使用[CLI使用说明](../USAGE.md)及动态本机服务，二者不能混用。

## 启动

原型原最低Node.js为22.22.3；当前仓库正式工程限定Node24 LTS，本机核对版本24.12.0。

```powershell
npm ci
$env:MGRP_SOURCE_ROOT = 'I:\moonton\mftools\mgrp'
npm run dev
```

历史默认端口为127.0.0.1:4317，不再提供运行链接。参考模式使用`npm run build:prototype`后`npm run start:prototype`；`PORT`可调整端口，命令与服务须使用相同环境。当前npm start/bin/harnessl3属于正式工程。

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

集成检查会创建明确标为检查用途的本机任务、截图与报告，技能集成还会临时创建并清理测试技能目录；它们不是只读检查。GC后的历史截图证据已保留在本目录validation/assets，以上命令重跑后会重新产生忽略的临时输出。历史通过数量和局限见[验证记录](VALIDATION.md)。

不要把model:generate作为普通刷新命令；它是首次引导脚本，默认拒绝覆盖已有模型，--force会显式重建。直接维护.c4后用model:validate核对即可。
