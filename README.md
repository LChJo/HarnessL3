# HarnessL3

面向现有agent的项目上下文CLI：以LikeC4文本为主模型，复用稳定简述批量选择上下文和技能，Web显示可追溯的输入到上下文包组织。

当前处于**正式首版验证收口**阶段。v0.16原型是已确认的交互/Slate视觉基准；工作规格v1.0与项目基准v0.19是实现契约。任务/技能/历史、只读观测、源码proof、Web和维护已有实现；Windows及原生Linux程序、浏览器和本地安装包有实际验证。原生macOS、性能及真实日志覆盖范围见[实施状态](docs/implementation/STATUS.md)。本地候选包0.1.0尚未发布。

## 开发入口

安装包及agent调用顺序见[CLI使用说明](docs/USAGE.md)。该说明、JSON Schema与示例随本地安装包提供。

1. [项目基准](docs/PROJECT_BASELINE.md)：目标、D01–D14、A01–A10及已确认边界。
2. [工作规格](docs/spec/README.md)：产品、架构、命令/Schema/示例、存储、日志/同步、Web与验收。
3. [实施顺序](docs/spec/implementation.md)：从M1开始，按失败测试→实现→验证推进。
4. [Agent维护约定](AGENTS.md)：工作区、同步与状态记录义务。

正式首版采用Node.js+TypeScript/npm，面向Windows/macOS/Linux；现有agent主动调用，首批只读观测Codex和Claude Code；只登记已有worktree；文件保存任务/事件/快照，SQLite为可重建派生索引。不安装Hooks、不启动agent，不把技能选择当执行。

## 原型与技能

- [已确认原型](docs/prototype/README.md)：最终设计、6张终版截图、历史依据与验证范围。
- [原型复现资料](docs/prototype/RUNNING.md)：仅保留历史命令和机器配置作参考；正式使用从CLI说明进入。
- [Skill Hub技能文件](skills/README.md)：7类20方法，作为可编辑文件分发与维护，保留MIT与来源。
- [MGRP示例主模型](examples/mgrp/model/01-project.c4)及[证据引用](examples/mgrp/evidence.json)：业务来源只读，模型为审查示例，不是正式产品默认项目。
- [清理记录](docs/prototype/CLEANUP.md)：临时产物回收与保留内容核验。

旧选版与旧界面只作为原型子文档中的历史资料，不提供旧产品运行入口。开源调研保留[当时结论](docs/research/open-source-project-visualization-survey-2026-11-04.md)，当前已选LikeC4。

## 验证状态

原型此前实际通过45项程序测试及16脑图、8历史、10技能集成；既有缓存重试有一次偶发失败，未定位原因，见[验证资料](docs/prototype/VALIDATION.md)。这些结果不替代[正式验收矩阵](docs/spec/acceptance.md)；正式实现的命令、结果与平台范围单独留证。

文档/GC完成情况记录在清理页；开发里程碑写Codux终端summary，产品历史保存在自身本机归档，两者不互代。
