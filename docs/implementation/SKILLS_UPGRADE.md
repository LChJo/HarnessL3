# v0.48 技能库与路由升级

2026-11-11；用户已确认按26项稳定方法升级仓库、候选包、全局CLI及本机活动库。来源、26项用途映射、逐项变化原因、依赖适配及ask-matt取舍见[随包审计](../../skills/UPSTREAM.md)。本记录区分实现、验证和本机交付，不作为安装流程。

## 实现范围

- CLI候选0.1.1；基准0.48；Skill Hub路由版本skill-hub/2。公共JSON字段和现有版本兼容，旧技能方案保存原routerVersion，不改写归档。
- 7类26项。新增pr、retro、wizard、implement-spec、wait-what、to-questionnaire、writing-for-agents，删除当前writing-great-skills及resolving-merge-conflicts；保留quick。beta只评估不默认分发。
- 保留本地分类、自包含、已内联依赖、项目知识权威和长期材料维护约定。GLOSSARY与附件入链同步；新HTML逻辑原型、标准发现、forced-red变异验证、工单归属/阻塞模板及测验修复纳入。
- ask-matt及PHASE-BOUNDARIES只贡献正文先读、实际目的和阶段判断；动态目录保持权威，不强制setup、访谈、固定token阈值、清上下文、委派或worktree。
- model maintain revise已返回当前agent指引；22对象/31关系及三个视图原有职责覆盖复核，更新context/runtimeSkill/library与依据，保持实体身份。没有新运行模块，不为每份方法新增模型节点。

## 升级前留证

实际工作区main，起点437943890e7ccd33737b2b6f19eb87a25d2b4fe1，原先工作区干净。上游本地参考固定4ae2317ddb22b046e26455e4f9c9b3aaaf62212d，不回写或fetch。

本机活动库入口是junction，实体ID为8ca0a46b-a0d2-4fc0-8d38-579198bf47ea；原库46文件、21方法。原库与仓库种子有18份差异，逐行对照主要是尚未同步的长期知识/证据维护步骤，没有额外文件。本次以已保存的原库、原种子和最终种子核对后迁移，写入前再次检查原字节，保留实体和所有旧归档。

真实L3任务5d8e1b9e-de20-4baa-936c-5e061bda850d使用旧版本选择/读取implement和writing-great-skills，保存完整handoff作为安装前对照。备份、分离的stdout/stderr/退出码、文件清单和本机结果放在worktree外临时交付目录；最终验证报告复制至本worktree忽略的`.harness-local/validation/skills-upgrade/`，不提交用户档案或凭证。

## 验证状态

升级前技能及安装器基线33/33通过。首轮升级后63项检查中62通过，1项因审计文件尚未创建的导航断链失败；补齐UPSTREAM后技能检查24/24通过，包括26方法逐项独立捕获、附件引用、并发播种与已有空库保护。

完整npm test共398项：394通过、4平台能力跳过、0失败（650699ms）。CLI/Web构建通过；最终包162文件/407018字节，其54份库文件和5份运行时文件与实际源码原字节一致。隔离安装/重装、服务构建/RPC、旧交接对照及差异拒绝、无Git目录CLI和Edge157浏览均通过；技能详情桌面/手机0页面错误、原方案和批次不变。两份Bash模板经Git Bash语法核对。模型22对象/31关系、三个视图无未覆盖叶对象；仅两个新增工程文档未跟踪提示。

## 本机交付

首次stop明确返回BUSY/draining，未改写安装。原实例退出后，另一调用在间隙启动了新实例；重新核实身份并等待其排空，不强杀、删锁或把换实例当作已停止。随后确认原所有者退出，再安装全局0.1.1并复制两宿主runtime skill。活动库在原实体内39次写入、4处路径退役，54文件与最终种子一致，junction及历史保留。

实际服务指纹374af29e39eeac519759eb1bfc82a9f1ab587c8f8ca8859fb46d4bf9e5c427fa；真实旧handoff匹配（219757ms）。旧批次implement/writing-great-skills原字节不变；同任务追加implement/writing-for-agents后，旧批次退役方法仍能读取，新正文与源码一致。

原包、原活动库、原种子与handoff保存在`.harness-local/backups/skills-upgrade-20261111/`，验证报告位于`.harness-local/validation/skills-upgrade/`。候选包`.harness-local/artifacts/harnessl3-0.1.1.tgz`的SHA512为`vIaqXtWlxwi46qpgs56lookILHf26cQ/EqKQu73Ewe2y0scyjA27y19DKKh1G7kf8PxSksgGzJ/bbw5KMYpH3g==`，构建明确标记modified source。当前新方法、审计和工程记录与模型共同留存，未自动暂存。

正常安装仍不覆盖已有库。本机更新只按本次授权实施，不新增自动覆盖命令。升级验收阶段未修改来源排除、创建Git/worktree、清理未知文件、暂存、commit、push或发布npm；后续用户已授权整理临时产物并提交推送，范围见[清理记录](CLEANUP.md)。未运行的平台及真实宿主加载效果不能借既有结论标通过。

## 原生CI安装故障与修复（2026-11-12）

提交063c768的[原生CI](https://github.com/LChJo/HarnessL3/actions/runs/43056794193)中，Windows/macOS完整任务成功；Ubuntu 24.04的398项程序测试394通过、4显式跳过、零失败，随后`playwright install --with-deps chromium`因Ubuntu镜像DNS解析失败而退出100。日志显示浏览器共享运行库均已安装，待下载的9个包均为附加字体；`azure.archive.ubuntu.com`持续无法解析。失败任务重跑一次，同时核对到[同日上游故障报告](https://github.com/actions/runner-images/issues/15296)，不把基础设施错误归因于技能正文或产品回归。

CI改用`playwright install chromium`下载锁定版本对应的浏览器，使用托管runner已有的共享库，避免每次无条件调用apt。既有browser-smoke和package-smoke仍实际启动Chromium并执行所有门禁，缺少运行库或其它启动错误仍会失败；没有切换系统浏览器、忽略安装失败、增加平台跳过或放宽断言。本次没有新增运行模块或改变产品契约，现有隔离验证对象补充CI准备职责及工作流证据。三平台完整结果以修复提交的GitHub Actions运行及终端总结为准，不以本机检查替代。

原始失败日志、重跑回执和后续运行结果保存在忽略的`.harness-local/validation/ci-fix-20261112/`，不提交凭据或本机任务档案。
