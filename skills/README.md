# Skill Hub 可编辑技能文件

Skill Hub 是 CLI 入口能力；普通技能是当前 agent 可按需读取的文件引用。目录从 `skills/<category>/<name>/SKILL.md` 自动发现；ID 是当前 `<category>/<name>` 路径，`name` 唯一，`description` 说明何时有用。目录移动会改变当前 ID 和版本；历史保留选择时的 ID/文件。轻目录和引用关系是派生结果，不维护第二份运行注册表。

## 按任务用途分类

当前为 **7 类、26 项方法**。类别描述主要用途，不要求 agent 按类别顺序执行；跨类方法可一次联合选择。

| 目录 | 用途 | 方法 |
| --- | --- | --- |
| `discovery/` | 需求澄清与研究：找事实、澄清未决选择 | [grilling](discovery/grilling/SKILL.md)、[grill-with-docs](discovery/grill-with-docs/SKILL.md)、[research](discovery/research/SKILL.md)、[to-questionnaire](discovery/to-questionnaire/SKILL.md) |
| `planning/` | 规格与任务规划：形成规格、拆分工作和管理决策 | [to-spec](planning/to-spec/SKILL.md)、[to-tickets](planning/to-tickets/SKILL.md)、[triage](planning/triage/SKILL.md)、[wayfinder](planning/wayfinder/SKILL.md) |
| `architecture/` | 架构与领域建模：接口边界、术语和架构改进 | [codebase-design](architecture/codebase-design/SKILL.md)、[domain-modeling](architecture/domain-modeling/SKILL.md)、[improve-codebase-architecture](architecture/improve-codebase-architecture/SKILL.md) |
| `development/` | 快速任务、开发与原型：简单问答、明确小改动、实现、设计验证、PR正文与人工向导 | [quick](development/quick/SKILL.md)、[implement](development/implement/SKILL.md)、[prototype](development/prototype/SKILL.md)、[implement-spec](development/implement-spec/SKILL.md)、[pr](development/pr/SKILL.md)、[wizard](development/wizard/SKILL.md) |
| `quality/` | 调试、测试与审查：定位故障、行为回归和复核 | [diagnosing-bugs](quality/diagnosing-bugs/SKILL.md)、[tdd](quality/tdd/SKILL.md)、[code-review](quality/code-review/SKILL.md)、[retro](quality/retro/SKILL.md) |
| `knowledge/` | 知识传递：跨工作阶段交接与教学 | [handoff](knowledge/handoff/SKILL.md)、[teach](knowledge/teach/SKILL.md)、[wait-what](knowledge/wait-what/SKILL.md) |
| `meta/` | 技能与项目约定维护：改进方法文件、梳理项目工作约定 | [writing-for-agents](meta/writing-for-agents/SKILL.md)、[setup-matt-pocock-skills](meta/setup-matt-pocock-skills/SKILL.md) |

`grill-me` 原来只转引 grilling，没有独立步骤或附件，已删除；通用访谈统一使用 [grilling](discovery/grilling/SKILL.md)。[grill-with-docs](discovery/grill-with-docs/SKILL.md) 保留：它在访谈之外还关联领域术语和设计决策记录。目录和方法分工以实际文件为准，本表仅供维护导航。

编辑 `SKILL.md` 或附件、添加或删除技能目录后，无需重新编译 CLI。Hub 自动重建当前目录，也可手动刷新；目录更新不会改写技能正文或替 agent 作选择。文件内容变化会改变版本，已有任务仍保留选择时的归档文件；新选择须使用当前有效目录。无效 YAML、重名、失效引用或文件越界应按目录诊断处理，不能当作有效技能执行。

[quick](development/quick/SKILL.md) 用于简单询问和改法已明确的小范围修改：在 L3 入口后直接完成，不额外记录过程、不执行验证。L3 入口已有记录与宿主日志仍保留；该方法不提供无痕模式。

长期规格、任务文档、决策、研究和交接的增删改移，同阶段维护受影响的当前上下文/证据与文档入链；同一实体保留身份，历史不回写。留存/Git归属按用途决定，项目任务Markdown与本机task记录分开，`.scratch`名字不代表可以丢弃。各产出方法在相应步骤提示维护；需要核查长期关联或证据时退出quick，沿用项目的阶段同步规则。CLI不自动建立文档对象或替agent理解正文。

默认方法独立使用：不含跨技能 `SKILL.md` 链接、`related` 清单或指向库根目录的维护说明；保留本方法目录内真实附件的相对链接，必要行为写入正文。任务仅归档显式所选方法的文件夹，不能假定其它方法或共享说明也已提供。用户自有技能的可选 `related` 仍兼容，作为目录候选展示，不自动加入选择。移动或删除时检查附件入链、CLI 示例及调用方。执行和归档约定见 [文件引用约定](FILE-REFERENCES.md)。

当前适配来源为 [Matt Pocock skills](https://github.com/mattpocock/skills) **1.3.2**，本地只读参考提交 [4ae2317](https://github.com/mattpocock/skills/commit/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d)；上一轮来源为 LChJo/skills 的2ab9580。更新原因、26项映射、依赖适配及未分发内容见[来源与升级核对](UPSTREAM.md)。保留 [MIT许可](LICENSE)、copyright 2026 Matt Pocock及pr附件中的作者致谢。来源库未回写；本版本不声称是网络最新版本。

其中quick为HarnessL3方法，其余25项来自上述稳定范围。ask-matt由内置Hub路由承担，grill-me的重复包装继续省略；chief-of-staff、software-factory仍是beta，不随默认库分发。writing-great-skills已由writing-for-agents替代，resolving-merge-conflicts退出当前目录；旧任务仍读取选择时的文件。
