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
| macOS | 未执行；用户已授权新审阅分支及原生三平台CI，待首次推送触发。不能把工作流文件或授权当通过证据 |
| 性能 | 最终四规模采样中；此前smoke、优化对照及中断样本独立保存，不混入最终P50/P95，不声明SLA |

Windows使用Node24.12.0/npm11.6.2/Git2.51、Edge156；Linux使用WSL Ubuntu内原生Node24.12.0/Git2.43/Chromium，非Windows可执行文件透传。手机是390×844触摸仿真，不代表全部物理设备。原生Linux早期139项核心通过仅有命令输出，首次JUnit因临时目录清空未保留；后续脚本均退出前回存报告，不编造缺失报告。

JUnit/浏览报告在本机`.harness-local/validation/`；阶段RED/GREEN、保护清单及性能原始样本在`.harness-local/implementation-20261105/`；最终包与安装报告在`.harness-local/artifacts/`。上述本机产物不随Git提交。

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

第二个独立里程碑summary cda7ceb7-5c04-4d99-904b-8fd9896f05cf已写并读回。剩余：四规模性能、最终文档/保护核验、原生macOS结果，以及TC10真实负例样本未覆盖部分。T14及完整用户目标保持进行中。
