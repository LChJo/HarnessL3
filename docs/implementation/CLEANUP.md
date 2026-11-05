# 首版实施期临时产物核验

2026-11-06。本页记录T14实施期回收，区别于[M0准备阶段清理](../prototype/CLEANUP.md)。产品档案GC的实现/验收使用合成独立数据根，未对真实85份开发历史执行apply或迁移。

## 已回收

- 停止记录中的旧原型进程49756：核对node.exe、启动时间及`server/index.mjs --production`命令后停止。4317/4318不再作为产品入口，历史运行说明保留参考命令并移除运行链接。
- 通过各自data-dir的认证CLI停止两个自有浏览夹具服务，再核查绝对临时目录、父目录、非链接入口及合成README标记，删除`harnessl3-browser-vJvUZH`和首次失败的`harnessl3-browser-i9bvbZ`。
- 删除已不再占用的`harnessl3-workspace-3BmJef`测试目录。它来自Windows after清理EBUSY的RED，后续测试使用有界原生删除重试，未放宽业务断言。
- Linux成功验证的独立源码副本由脚本在回存JUnit/浏览图/安装报告后删除。首次失败副本`harnessl3-native-linux-full.c9XuRGcj`在修复回归通过、RED报告已保留且核对realpath边界后删除。
- browser-smoke/package-smoke及性能运行器自行停止并回收各自成功夹具；最终四规模性能已正常结束，全部自有服务停止，临时性能目录核查为空。测量中的目录从未提前回收。

## 保留与核验

保留原型src/server/scripts/tests、examples、20项技能/附件/MIT/来源、原机器来源配置与全部历史。保护清单`.harness-local/implementation-20261105/protected-before.json`的202项SHA-256已全部一致，原运行目录含85条任务与2个上下文快照，不作新产品的恢复测试。

阶段RED、最终GREEN、真实脱敏日志的形状审计、性能原始样本、保护/回收收据及本地候选包保留于忽略目录。首次139项Linux运行丢失的JUnit没有补造。隔离的Node/Chromium验证工具缓存保留以便重跑，Windows Chromium位于本机忽略目录`.harness-local/tools/playwright`；它们不是用户技能库或产品历史。

默认用户技能入口指向的`.skills-library-<UUID>`是持久内容，不能因名称含点或UUID而当临时文件。本轮只回收已停止的独占测试根及其内部合成技能副本，不清理用户活动技能根。

## 暂留的隔离探针文件

新增原生宿主探针只使用自建合成文件，日志最小脱敏后才进入测试。128MiB中断探针的源目录已由其运行器回收。显式删除另外的8MiB Codex合成文件及首个Claude临时目录时，自动审批两次返回`blocked by policy`（包括改成已核对的固定绝对路径后），因此保留它们，没有改用其它工具绕过删除拒绝。

暂留位置为本机`.harness-local/validation/codex-read-pending-fixture.txt`和系统Temp下`harnessl3-claude-protocol-*`、`harnessl3-claude-shell-*`的自建合成目录；不随Git或npm包上传。新探针原始宿主日志留在本机，用户原有会话日志保持只读。保留这些文件不表示产品GC删除了用户历史。

当前验证状态见[STATUS](STATUS.md)。没有执行git clean、切换用户分支、删除源码或永久删除任务历史。
