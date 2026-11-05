# 正式首版实施状态

2026-11-06，M1–M4首版本地候选0.1.0已实现并完成本页所列验收；功能提交`f8eb2a4`的最终三平台CI全部成功。本页记录代码与实际范围；[基准](../PROJECT_BASELINE.md)、[规格](../spec/README.md)及[完整验收目标](../spec/acceptance.md)保持一致，宿主工具子集、平台能力跳过与性能限制继续明确保留。

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

源码/知识同步核对：正式模块与命令已对照架构、CLI及存储契约；本轮轮询、截断和字面量字段界限同步到[观测规格](../spec/observation-sync.md)。MGRP示例模型/证据及普通技能没有改动，原字节列入保护核验；本轮不对其外部业务源码作新的语义同步声明。

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
| 历史三平台CI程序 | 第三轮每平台244项（199正式+45原型回归）：Windows240通过/4平台跳过，Linux243通过/1跳过，macOS241通过/3能力跳过，全部0失败；不是终版轮次的数量 |
| 最终三平台CI | 第六轮每平台256项（211正式检查+45原型回归）：Windows252通过/4平台跳过、Linux255通过/1跳过、macOS253通过/3能力跳过，全部0失败。三平台构建、显式CRLF浏览、安装和证据上传全部成功；第五轮也独立成功，轮次不合并 |
| Windows CRLF浏览回归 | 第四轮准确定位textarea的LF显示值与CRLF归档比较失败；在Chromium156、TEMP/TMP junction和显式CRLF种子下复现RED。分开校验API原字节/原引用SHA-256/长度与显示换行后，同条件三组全部通过、0页面异常；未修改生产前端 |
| 双日志补充回归 | Claude真实失败/Glob/有限Read/literal Bash/歧义中断，Codex有限Read/搜索/异步完成及空poll已加入最小脱敏夹具。空poll匹配及跨帧截断先4项行为RED，修复后observation29+replay2+agent CLI1在Windows/Linux各32/32通过。继承字段误归因另有实际1项RED，无原型解码修复后相同32项在两平台全部通过，并进入最终三平台通过轮次 |
| 性能 | 全量基线四规模112冷热组、336/336样本成功，28文件指纹在该轮一致。10000对象完整CLI混合读冷/热P50为99.59s/102.51s，最高RSS 2.73GiB。其后只有观测模块指纹改变，两个修复阶段分别独立复测日志积压8组24样本，均全部成功；[完整方法、表格及限制](PERFORMANCE.md)，不混样本、不声明SLA |

Windows使用Node24.12.0/npm11.6.2/Git2.51、Edge156；Linux使用WSL Ubuntu内原生Node24.12.0/Git2.43/Chromium，非Windows可执行文件透传。手机是390×844触摸仿真，不代表全部物理设备。原生Linux早期139项核心通过仅有命令输出，首次JUnit因临时目录清空未保留；后续脚本均退出前回存报告，不编造缺失报告。

已观察的平台能力跳过分开保留：Windows四项为两项POSIX信号取消、原始非法UTF-8文件名和POSIX大小写文件夹具（Windows原生取消另有ConPTY验证）；Linux一项为Windows独占文件共享锁；macOS三项为Windows锁、创建非法UTF-8文件名报EILSEQ、当前卷不能同时创建大小写不同的文件。其它平台已实际执行相应原生断言，未用这些跳过掩盖通用扫描或归档失败。

JUnit/浏览报告在本机`.harness-local/validation/`；阶段RED/GREEN、保护清单及性能原始样本在`.harness-local/implementation-20261105/`；最终包与安装报告在`.harness-local/artifacts/`。上述本机产物不随Git提交。

本地交付文件为`.harness-local/artifacts/harnessl3-0.1.0.tgz`：306989字节、解包1082537字节，128文件/20技能/2资产；最终SHA-512为`bkNVHjgJQ70wAlxflgEXA9ipBbM5eMAX2c7CKO7nUjWSrcMptcthxf0yGfScMqHaHgkMOBM3jVK4YSItFCKvow==`。归档摘要、全新安装、实际bin shim与任务读取链均已核验。使用Node24.12及Git，按[使用说明](../USAGE.md)安装和初始化；该tgz保留在本机，未发布公共npm。

## 原生CI运行记录

源代码、规格与测试已推至`codex/harnessl3-v1-20261106`，独立审阅worktree为`I:/AI/HarnessL3-review-v1-20261106`；原工作区main未切换，本机任务/日志/缓存未上传，未合并或发布npm。

- [首轮42066774412](https://github.com/LChJo/HarnessL3/actions/runs/42066774412)，`9f020fb`：整体失败；Ubuntu全部成功，Windows在npm test失败、浏览和安装因此未执行，macOS测试阶段长时间等待。实际失败保留，不能用本机通过掩盖。
- macOS路径前提已在Linux原生symlink TMPDIR下复现：取消测试用字面临时路径生成fake服务身份，而CLI使用canonical路径，导致等待服务接受无限挂起。原测试8秒超时RED；仅修夹具canonicalization、提前退出检测及20秒有界超时，同一前提2/2 GREEN，产品代码未改。
- [第二轮42069264423](https://github.com/LChJo/HarnessL3/actions/runs/42069264423)，`a389e40`：Ubuntu全通过；Windows237通过/3失败/4跳过，macOS238通过/4失败/2跳过。失败是fixture把Windows 8.3或macOS `/var`别名与canonical路径直接比较，另有Darwin不允许创建非法UTF-8文件名。新增JUnit摘要取得了准确断言；macOS上传报告另遇网络超时，未隐藏。
- foundation与maintenance夹具统一真实路径后，同样alias前提在Linux和Windows回归。Darwin只在创建非法文件名报`EILSEQ`时明确能力跳过；Linux仍真实执行编码诊断断言，未跳过扫描错误或放宽GC竞态断言。
- [第三轮42070719498](https://github.com/LChJo/HarnessL3/actions/runs/42070719498)，`2904010`：三平台程序全通过；Linux/macOS所有步骤成功，Windows browser-smoke失败。第四轮`73fb8ee`增加浏览/安装步骤的脱敏失败注释，继续定位，不把通用exit1猜成某个产品问题。
- [第四轮42073640063](https://github.com/LChJo/HarnessL3/actions/runs/42073640063)，`73fb8ee`：Linux/macOS全部成功；Windows程序通过、浏览失败。注释取得了准确的CRLF/LF断言，同条件本机RED→GREEN后，仅修验证脚本，并在第五轮三个平台显式注入CRLF种子。
- [第五轮42077870795](https://github.com/LChJo/HarnessL3/actions/runs/42077870795)，`5172157`：三平台全部成功，每平台256项程序检查；含日志空poll及跨帧截断修复、额外真实夹具、显式CRLF浏览归档字节核验及全新消费者安装。其后新增的继承字段保护由第六轮独立验证。
- [第六轮42079069041](https://github.com/LChJo/HarnessL3/actions/runs/42079069041)，`f8eb2a4`：最终三平台全部成功；每平台256项程序检查，浏览器与全新消费者安装均实际运行。字面量继承字段保护修复在本机Windows及原生Linux各32项通过后推送；最终公开结果和三份平台证据已生成。本机状态查询的一次网络超时没有被记为产品测试失败。

## 验收证据导航

下表列出首版验收的实际证据范围；工具子集和平台能力限制不补成完整覆盖。

| 场景 | 验证入口 | 当前边界 |
| --- | --- | --- |
| TC01–03、22–23 | workspace、cli-service、service-recovery、task-cli、cancellation | 三平台原生CI程序已实跑通过。Windows真实ConPTY另确认CLI子进程exit130；POSIX两项取消在Linux/macOS CI通过，Windows明确跳过POSIX信号夹具 |
| TC04–06、09、13–16、18–19 | model、skills、archive、index、context、task-cli及浏览器 | 精确读取、幂等/恢复、旧模型/技能/批次均从归档验证；三平台最终程序及浏览通过 |
| TC07–08 | source、freshness、sync-cli | 外部Git过滤器保守unknown，不执行用户脚本；Linux watcher实际差异已修复 |
| TC10–12 | observation、observation-replay、agent-cli及脱敏fixtures | 两宿主真实成功/失败、搜索、有限读取、受控迟到结果及自然完成空poll均有明确范围；歧义中断保留失败/未知类别。直接poll语法和未截断完成链仍synthetic-only；动态/聚合无法归因、非空poll及未验证格式保持未知，不泛称全部宿主工具覆盖。见[样本说明](../../tests/v1/fixtures/observation/README.md) |
| TC15、20–21 | web/verify-all.mjs三组 | Windows Edge及三平台Chromium通过；本机Windows显式CRLF/目录别名回归通过，最终三平台CI均显式使用CRLF种子 |
| TC17 | benchmark及browser-smoke commit→paint | 四规模/冷热/双worktree/恢复采样；明确共享机器负载与OS页缓存未清空，报告无SLA |
| TC24–25 | maintenance、maintenance-cli | 仅合成legacy复制，真实85任务不变；GC重算引用/租约，不删历史、技能实体或未知文件 |
| TC26 | build、browser-smoke、package-smoke、原生CI | 三平台最终构建/浏览/全新安装通过；Windows锁、Linux大小写原生断言有独立证据，能力跳过见上。手机为触摸仿真；未扩称所有物理设备通过 |

## 留痕与交付边界

早期M1/M2独立里程碑已写终端summary 8abe226e-29df-41cb-a3ce-08c5b48d97ce并读回；未修改共享notes。原型45项程序与正式程序分开统计，不用原型历史报告替代正式验收。

此前文档检查覆盖33份Markdown的249个内部链接/锚点；本轮当前文档范围25份/229链接最终检查通过，两次范围分开。9个Schema、15个正例、32个预期拒绝反例及跨字段检查通过，15正例另用核心Ajv2020全部验证。保护SHA清单核查202项无变化。

早期Windows Edge事件到可见输出三样本P50/P95为1668/1668ms，Linux Chromium为976/1236ms；最终Windows Chromium在显式CRLF与临时目录别名下为1156/1361ms。各轮不合并：定义是journal提交时间到准确输出数可见后的双requestAnimationFrame，含刷新/绘制调度、同机壁钟且每轮仅三样本，不是稳定长尾SLA。

第二个独立里程碑summary cda7ceb7-5c04-4d99-904b-8fd9896f05cf已写并读回。正式首版范围的实现、原生CI、安装和测量均有实际结果；当前基准v0.21。日志兼容范围已经逐项注明，未能归因的真实行为保留unknown，不能扩称完整宿主覆盖。数值SLA、更多宿主格式、公共npm发布及物理设备兼容属于后续范围；部分自建合成文件因自动审批拒绝删除而保留，见[清理记录](CLEANUP.md)。最终留痕在完成文档/保护复核后写入终端summary，不修改共享notes。
