# HarnessL3

面向现有agent的项目上下文CLI：以LikeC4文本为主模型，复用稳定简述批量选择上下文和技能，Web显示可追溯的输入到上下文包组织。

通过命令行按需读取项目上下文与技能，并在 Web 无限画布中查看任务组织、历史及来源依据。安装和更新见下文，功能与验证范围见[实施状态](docs/implementation/STATUS.md)。

## 安装与更新

让 agent 阅读根目录的[安装与更新指南](INSTALL.md)，即可从 GitHub 安装或更新 HarnessL3 CLI，并将 [harnessl3 运行时 skill](agent-skills/harnessl3/SKILL.md) 及参考附件复制到 Codex 与 Claude Code 的全局技能目录。skill 指导真实 agent 调用 CLI 获取上下文、选择/读取技能和完成同步；安装更新和项目初始化指导放在附带 Markdown 中，仅在需要时关联读取。实际命令为 `harnessl3`。

安装后，agent 为各类任务选择上下文与技能，并复用有效的连续任务绑定；无需材料时可明确空选，子任务可继承父任务交接。首次使用前，请新建或刷新宿主会话。

当前工作区首次未登记时，agent会通过通用询问窗口确认：同意后接入，由当前大模型阅读项目、编写对象/关系/证据并报告进度，校验结构后继续；拒绝或取消则普通执行。上下文实际交接后只显示“查看可视化过程”文字超链。默认用户服务常驻，全部项目共享一个实例。

## 开发入口

安装包及agent调用顺序见[CLI使用说明](docs/USAGE.md)。该说明、JSON Schema与示例随本地安装包提供。

当前CLI可通过顶层、命令组与子命令`--help`按需发现参数及契约文件；skill负责调用时机与结果使用。职责依据、发现的问题及修补范围见[CLI与skill核对](docs/implementation/CLI_SKILL_REVIEW.md)。

1. [项目基准](docs/PROJECT_BASELINE.md)：目标、D01–D15、A01–A10及新增TC27入口验收边界。
2. [工作规格](docs/spec/README.md)：产品、架构、命令/Schema/示例、存储、日志/同步、Web与验收。
3. [实施顺序](docs/spec/implementation.md)：从M1开始，按失败测试→实现→验证推进。
4. [Agent维护约定](AGENTS.md)：工作区、同步与状态记录义务。

正式首版采用Node.js+TypeScript/npm，面向Windows/macOS/Linux；现有agent主动调用，首批只读观测Codex和Claude Code；只登记已有worktree；文件保存任务/事件/快照，SQLite为可重建派生索引。不安装Hooks、不启动agent，不把技能选择当执行。

## 原型与技能

- [已确认原型](docs/prototype/README.md)：最终设计、6张终版截图、历史依据与验证范围。
- [独立原型归档](https://github.com/LChJo/HarnessL3/tree/archive/prototype-v0.16)：可单独检出运行v0.16，包含原型源码/设计/模型/技能及[本次复验](https://github.com/LChJo/HarnessL3/blob/archive/prototype-v0.16/docs/prototype/ARCHIVE.md)。
- [原型复现资料](docs/prototype/RUNNING.md)：仅保留历史命令和机器配置作参考；正式使用从CLI说明进入。
- [Skill Hub技能文件](skills/README.md)：7类21方法，含简单问答和明确小改动使用的 quick，作为可编辑文件分发与维护，保留MIT与来源。
- [MGRP示例主模型](examples/mgrp/model/01-project.c4)及[证据引用](examples/mgrp/evidence.json)：业务来源只读，模型为审查示例，不是正式产品默认项目。
- [清理记录](docs/prototype/CLEANUP.md)：临时产物回收与保留内容核验。

冻结原型在归档分支独立复现，旧选版和更早界面仍只作历史参考。当前工作区的正式入口保持CLI使用说明。开源调研保留[当时结论](docs/research/open-source-project-visualization-survey-2026-11-04.md)，当前已选LikeC4。

## 验证状态

原型此前实际通过45项程序测试及16脑图、8历史、10技能集成；既有缓存重试有一次偶发失败，未定位原因，见[验证资料](docs/prototype/VALIDATION.md)。这些结果不替代[正式验收矩阵](docs/spec/acceptance.md)；正式实现的命令、结果与平台范围单独留证。

文档/GC完成情况记录在清理页；开发里程碑写Codux终端summary，产品历史保存在自身本机归档，两者不互代。
