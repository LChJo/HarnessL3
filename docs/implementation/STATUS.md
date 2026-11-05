# 正式首版实施状态

2026-11-06，T14验证收口中。目标保持M1–M4的第一个完整可用版本。本页记录代码与证据；[基准](../PROJECT_BASELINE.md)、[规格](../spec/README.md)及[完整验收目标](../spec/acceptance.md)不因局部通过而收缩。

## 已有实现

| 范围 | 当前行为 | 主要代码/检查 |
| --- | --- | --- |
| 工程与工作区 | Node24.12/TS ESM；多项目及已有worktree登记；UUID/common-dir身份、目标及数据根隔离；init/seed不覆盖 | core/workspace.ts、paths.ts；workspace、cli-service、service-recovery |
| 文本模型 | 真实LikeC41.60解析、稳定UUID、别名/证据及多视图；无效模型保留有版本标记的有效结构 | core/model.ts；model、context、web-service |
| 上下文/技能 | 多目录/精确正文/跨层、首次known保护、partial、一次联合技能选择及显式空集；归档文件按需读 | core/context.ts、skills.ts；context、skills、task-cli |
| 持久化/历史 | 文件journal/不可变归档、幂等回执、提交恢复、worker SQLite重建；60天包含边界、分页及批次恢复 | core/archive.ts、index*.ts；archive、index、context |
| 源码同步 | 原始字节/忽略规则/策略、watcher epoch及扫描、模型与来源两轴、局部proof/CAS及真实失败 | core/source.ts、freshness.ts；source、freshness、sync-cli |
| 只读日志 | 显式绑定两宿主已核验子集；结果匹配、检查点、轮转/缺口/未知；不保存聊天正文或执行日志命令 | core/observation.ts；observation、observation-replay、agent-cli |
| 正式Web | Slate统一脑图、五类/Hub文件夹、真实批量选择、项目/worktree、历史/C4、SSE、锚点/触摸/离线 | web/；verify-fixture、verify-manual、verify-directory |
| 维护与包 | legacy复制导入/dry-run/幂等/冲突；保守GC；本地tgz安装、20项技能及离线资源 | core/maintenance.ts；maintenance、maintenance-cli、package-smoke |

调用顺序见[使用说明](../USAGE.md)。现有agent主动调用；CLI不启动agent、不执行技能、不管理Git worktree生命周期。当前本地候选版本0.1.0，未向npm发布。

## 本轮实际结果

测试使用外部临时Git、数据根、日志与技能副本。真实85份开发任务不是恢复/迁移/GC夹具；202个受保护文件已再次核对SHA-256全部一致。

| 环境/检查 | 实际结果与范围 |
| --- | --- |
| Windows程序全量轮次 | 242项：239通过、0失败、3项明确平台跳过；197项正式检查与45项原型回归分开。首次after清理EBUSY已修；中间新增真实fixture的RED也单独保留，最终使用完整固定夹具重跑通过。后补原生FS专项另列 |
| Windows日志幂等修复 | 先2项RED，修复后19/19通过；已提交alias路径失效先重放回执。bind-replay-red.xml / bind-replay-green.xml留存 |
| Windows正式浏览器 | browser-smoke统一三组通过、0 page errors。含三技能联合选择、空集、丢响应后同ID重试、目录增改删/恢复、固定历史、legacy/C4、目标竞态、触摸/离线；[命令和JSON](../../web/README.md) |
| Windows本地包 | 全新中文/空格消费者安装、实际npm bin shim、任务→选择→归档文件读取均通过；128文件、20技能、2本地Web资产、sha512核验 |
| 原生Linux首次完整程序 | 239项：238通过、1失败、0跳过。实际recursive fs.watch返回string，被误按Buffer解码而unknown；已保留RED并修复 |
| 原生Linux最终完整程序 | 修复后241/241通过、0跳过；随后新增的真实Codex失败样本连同日志/alias在独立19/19中通过。两次报告分开，不拼称一次242项报告；freshness/source32/32的RED→GREEN另存 |
| 原生Linux浏览器/包 | Chromium156的三组browser-smoke通过、0 page errors；中文/空格消费者安装、实际npm bin shim及归档任务链通过。128文件、20技能、2资产及sha512核验 |
| TC26原生FS专项 | 后补2项：Windows真实FileShare.None外部持锁下原子替换拒绝/旧字节不变，释放后成功；Linux同目录大小写文件的Git路径/哈希/变更分离。两平台各1通过/1明确能力跳过，无sleep；不拼入先前完整轮次数字 |
| 原生三平台CI程序 | 第三轮每平台244项（199正式+45原型回归）：Windows240通过/4平台跳过，Linux243通过/1跳过，macOS241通过/3能力跳过，全部0失败；跳过原因和前两轮失败独立保留 |
| 原生CI浏览/安装 | 第三轮Linux和macOS构建、浏览、安装全部成功；Windows在browser-smoke失败、安装因此跳过，本机Edge/安装通过不能替代该失败。第四轮补充步骤诊断后继续 |
| 性能 | 四规模112冷热组、336/336样本成功，28文件指纹全程一致。10000对象完整CLI混合读冷/热P50为99.59s/102.51s，最高RSS 2.73GiB；[完整方法、表格及限制](PERFORMANCE.md)，不声明SLA |

Windows使用Node24.12.0/npm11.6.2/Git2.51、Edge156；Linux使用WSL Ubuntu内原生Node24.12.0/Git2.43/Chromium，非Windows可执行文件透传。手机是390×844触摸仿真，不代表全部物理设备。原生Linux早期139项核心通过仅有命令输出，首次JUnit因临时目录清空未保留；后续脚本均退出前回存报告，不编造缺失报告。

JUnit/浏览报告在本机`.harness-local/validation/`；阶段RED/GREEN、保护清单及性能原始样本在`.harness-local/implementation-20261105/`；最终包与安装报告在`.harness-local/artifacts/`。上述本机产物不随Git提交。

## 原生CI运行记录

源代码、规格与测试已推至`codex/harnessl3-v1-20261106`，独立审阅worktree为`I:/AI/HarnessL3-review-v1-20261106`；原工作区main未切换，本机任务/日志/缓存未上传，未合并或发布npm。

- [首轮42066774412](https://github.com/LChJo/HarnessL3/actions/runs/42066774412)，`9f020fb`：Ubuntu全部成功；Windows在npm test失败，浏览和安装因此未执行；macOS停留于测试等待。实际失败保留，不能用本机通过掩盖。
- macOS路径前提已在Linux原生symlink TMPDIR下复现：取消测试用字面临时路径生成fake服务身份，而CLI使用canonical路径，导致等待服务接受无限挂起。原测试8秒超时RED；仅修夹具canonicalization、提前退出检测及20秒有界超时，同一前提2/2 GREEN，产品代码未改。
- [第二轮42069264423](https://github.com/LChJo/HarnessL3/actions/runs/42069264423)，`a389e40`：Ubuntu全通过；Windows237通过/3失败/4跳过，macOS238通过/4失败/2跳过。失败是fixture把Windows 8.3或macOS `/var`别名与canonical路径直接比较，另有Darwin不允许创建非法UTF-8文件名。新增JUnit摘要取得了准确断言；macOS上传报告另遇网络超时，未隐藏。
- foundation与maintenance夹具统一真实路径后，同样alias前提在Linux和Windows回归。Darwin只在创建非法文件名报`EILSEQ`时明确能力跳过；Linux仍真实执行编码诊断断言，未跳过扫描错误或放宽GC竞态断言。
- [第三轮42070719498](https://github.com/LChJo/HarnessL3/actions/runs/42070719498)，`2904010`：三平台程序全通过；Linux/macOS所有步骤成功，Windows browser-smoke失败。第四轮`73fb8ee`增加浏览/安装步骤的脱敏失败注释，继续定位，不把通用exit1猜成某个产品问题。

## 验收证据导航

下表不将跨平台完整TC提前标为passed。

| 场景 | 验证入口 | 当前边界 |
| --- | --- | --- |
| TC01–03、22–23 | workspace、cli-service、service-recovery、task-cli、cancellation | Windows/Linux已实跑并修复重跑通过；macOS待验。Windows真实ConPTY确认CLI子进程exit130；POSIX两项取消在Linux通过 |
| TC04–06、09、13–16、18–19 | model、skills、archive、index、context、task-cli及浏览器 | 精确读取、幂等/恢复、旧模型/技能/批次均从归档验证；完整平台范围依最终报告 |
| TC07–08 | source、freshness、sync-cli | 外部Git过滤器保守unknown，不执行用户脚本；Linux watcher实际差异已修复 |
| TC10–12 | observation、observation-replay、agent-cli及脱敏fixtures | 真实Codex成功/失败单读及聚合、Claude Read/Edit/Grep/Write已核对。实际未发现Claude失败/取消/Glob；部分负例仅合成，仍partial，不能泛称所有工具通过。见[样本说明](../../tests/v1/fixtures/observation/README.md) |
| TC15、20–21 | web/verify-all.mjs三组 | Windows Edge及原生Linux Chromium通过；macOS待验 |
| TC17 | benchmark及browser-smoke commit→paint | 四规模/冷热/双worktree/恢复采样；明确共享机器负载与OS页缓存未清空，报告无SLA |
| TC24–25 | maintenance、maintenance-cli | 仅合成legacy复制，真实85任务不变；GC重算引用/租约，不删历史、技能实体或未知文件 |
| TC26 | build、browser-smoke、package-smoke、原生CI | Windows/Linux本地候选安装及Web通过；macOS尚未运行，不宣布三平台完成 |

## 留痕与剩余工作

早期M1/M2独立里程碑已写终端summary 8abe226e-29df-41cb-a3ce-08c5b48d97ce并读回；未修改共享notes。原型45项程序与正式程序分开统计，不用原型历史报告替代正式验收。

文档检查实际通过33份Markdown的249个内部链接/锚点；9个Schema、15个正例、32个预期拒绝反例及跨字段检查通过，15正例另用核心Ajv2020全部验证。保护SHA清单核查202项无变化。

当前Windows事件到可见输出三样本P50/P95为1668/1668ms，Linux为976/1236ms；定义是journal提交时间到准确输出数可见后的双requestAnimationFrame，含刷新/绘制调度、同机壁钟且仅三样本，不是稳定长尾SLA。

第二个独立里程碑summary cda7ceb7-5c04-4d99-904b-8fd9896f05cf已写并读回。剩余：原生CI失败收敛、最终文档/保护核验，以及TC10真实负例样本未覆盖部分；四规模性能已完成。T14及完整用户目标保持进行中。
