# Skill Hub 可编辑技能文件

Skill Hub 是 CLI 入口能力；普通技能是当前 agent 可按需读取的文件引用。目录从 `skills/<category>/<name>/SKILL.md` 自动发现；ID 是当前 `<category>/<name>` 路径，`name` 唯一，`description` 说明何时有用。目录移动会改变当前 ID 和版本；历史保留选择时的 ID/文件。轻目录和引用关系是派生结果，不维护第二份运行注册表。

## 按任务用途分类

当前为 **7 类、21 项方法**。类别描述主要用途，不要求 agent 按类别顺序执行；跨类方法可一次联合选择。

| 目录 | 用途 | 方法 |
| --- | --- | --- |
| `discovery/` | 需求澄清与研究：找事实、澄清未决选择 | [grilling](discovery/grilling/SKILL.md)、[grill-with-docs](discovery/grill-with-docs/SKILL.md)、[research](discovery/research/SKILL.md) |
| `planning/` | 规格与任务规划：形成规格、拆分工作和管理决策 | [to-spec](planning/to-spec/SKILL.md)、[to-tickets](planning/to-tickets/SKILL.md)、[triage](planning/triage/SKILL.md)、[wayfinder](planning/wayfinder/SKILL.md) |
| `architecture/` | 架构与领域建模：接口边界、术语和架构改进 | [codebase-design](architecture/codebase-design/SKILL.md)、[domain-modeling](architecture/domain-modeling/SKILL.md)、[improve-codebase-architecture](architecture/improve-codebase-architecture/SKILL.md) |
| `development/` | 快速任务、开发与原型：简单问答、明确小改动、实现、设计验证与合并冲突处理 | [quick](development/quick/SKILL.md)、[implement](development/implement/SKILL.md)、[prototype](development/prototype/SKILL.md)、[resolving-merge-conflicts](development/resolving-merge-conflicts/SKILL.md) |
| `quality/` | 调试、测试与审查：定位故障、行为回归和复核 | [diagnosing-bugs](quality/diagnosing-bugs/SKILL.md)、[tdd](quality/tdd/SKILL.md)、[code-review](quality/code-review/SKILL.md) |
| `knowledge/` | 知识传递：跨工作阶段交接与教学 | [handoff](knowledge/handoff/SKILL.md)、[teach](knowledge/teach/SKILL.md) |
| `meta/` | 技能与项目约定维护：改进方法文件、梳理项目工作约定 | [writing-great-skills](meta/writing-great-skills/SKILL.md)、[setup-matt-pocock-skills](meta/setup-matt-pocock-skills/SKILL.md) |

`grill-me` 原来只转引 grilling，没有独立步骤或附件，已删除；通用访谈统一使用 [grilling](discovery/grilling/SKILL.md)。[grill-with-docs](discovery/grill-with-docs/SKILL.md) 保留：它在访谈之外还关联领域术语和设计决策记录。目录和方法分工以实际文件为准，本表仅供维护导航。

编辑 `SKILL.md` 或附件、添加或删除技能目录后，无需重新编译 CLI。Hub 自动重建当前目录，也可手动刷新；目录更新不会改写技能正文或替 agent 作选择。文件内容变化会改变版本，已有任务仍保留选择时的归档文件；新选择须使用当前有效目录。无效 YAML、重名、失效引用或文件越界应按目录诊断处理，不能当作有效技能执行。

[quick](development/quick/SKILL.md) 用于简单询问和改法已明确的小范围修改：在 L3 入口后直接完成，不额外记录过程、不执行验证。L3 入口已有记录与宿主日志仍保留；该方法不提供无痕模式。

跨技能方法用相对 `SKILL.md` 链接表达；可选 frontmatter `related` 数组只给出关联文件，不自动加入选择集合。例如 quality/tdd 同类引用 `../code-review/SKILL.md`，planning/triage 跨类引用 `../../discovery/grilling/SKILL.md`。附件路径相对其所在文件；移动或删除时同步 Markdown 链接、YAML related、CLI 示例及调用方。执行和归档约定见 [文件引用约定](FILE-REFERENCES.md)。

最初 21 项来自本地参考提交 `2ab958093e83e0ec752e6c1c5932da465bf23e0c`：[LChJo/skills](https://github.com/LChJo/skills)，上游为 [Matt Pocock skills](https://github.com/mattpocock/skills)。原导入范围为 engineering 16 项和 productivity 5 项；v0.14 按用途重分类，删除重复包装后保留 20 项。保留方法名称、[MIT 许可](LICENSE) 及 copyright 2026 Matt Pocock；不回写 `E:/Ai/skills`，不承诺这是上游最新状态。

本地库现有 21 份方法正文、21 份参考 Markdown 和 1 份 Bash 模板（共 43 个方法目录内文件）；其中 quick 为 HarnessL3 新增方法，其余 20 项来自上述导入。先前已移除 21 份宿主专用 `agents/openai.yaml`。原 slash 调用已改为文件引用；提交、tracker、会话及并行 agent 遵守实际授权和工具能力。`meta/setup-matt-pocock-skills` 保留历史方法名，仅用于可选项目约定梳理。来源与 v0.13 适配见 [历史审计](../docs/prototype/archive/design/skill-hub-file-audit.md)，当前目录迁移见 [v0.14 记录](../docs/prototype/archive/design/skill-taxonomy.md)。
