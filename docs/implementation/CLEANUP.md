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

## v0.44 提交前清理（2026-11-10）

按用户要求核对并清理本轮产物：25个Windows原型测试夹具通过创建时间、源码中的mkdtemp前缀、合成内容标记与无占用进程检查后删除；回收4个一次性建模/WSL驱动脚本及12个CLI临时传输文件。Windows删除逐层检查路径与reparse point，只删除链接本身，不进入目标；没有改动用户技能库、真实任务历史、依赖或工具缓存。

三份已记录的Linux原生临时源码副本在本次复查时已不存在，未记作本次删除；其中原/tmp候选包也已不可用，保留原报告，不补造原包。现存Windows最终候选包、Windows/Linux最终验证报告、失败与成功同步回执及任务档案均保留。本机核验清单位于`.harness-local/validation/directory-cleanup-windows.json`及`directory-cleanup-linux.json`。

继续删除14份重复本机输出的命令被自动审批拒绝，返回`blocked by policy`；该命令没有执行。重复输出、后续清理用的两个系统Temp辅助脚本及空目标目录保留，不使用其它工具绕过拒绝。此限制不影响源码提交与推送，也不意味着已删除所有本机临时产物。

提交前对三份已有LF约定的源码恢复LF，并为五份新增且被当前证据引用的文本补齐LF属性；刷新当前证据原字节哈希，不改旧档案。功能及平台验证范围沿用[本轮状态](STATUS.md)，不因清理或提交而补称macOS或完整三平台验收通过。

## v0.48 提交前核对（2026-11-12）

按用户要求检查当前main工作区的全部跟踪和未跟踪变更，并在依赖、构建输出和本机归档之外查找临时文件。此前来源观测记录中的原子写入文件（如`tests/v1/*.tmp.<PID>.<随机后缀>`及`web/*.tmp.<PID>.<随机后缀>`）现已不存在，本次不记作删除。新增`*.tmp.[0-9]*.*`忽略规则，避免后续同类中间文件进入提交；不使用宽泛的临时文件清理或git clean。

技能、运行时路由、规格、测试和当前模型证据一起版本管理。`.harness-local/`、`build/`、`dist/`及`node_modules/`继续按已有规则排除；升级前备份、候选包、平台验证报告、任务历史及活动用户技能实体全部保留。系统Temp中的旧探针及曾被自动审批拒绝的清理目标不在本次删除范围。新增工程记录补充LF属性，当前证据保留原ID并刷新字节哈希。

功能验证沿用[技能升级记录](SKILLS_UPGRADE.md)中的Windows完整测试与安装验证；提交阶段另做差异、排除规则、包文件清单及模型证据核对，不据此扩大平台或宿主验收结论。
