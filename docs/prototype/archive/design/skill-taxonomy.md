> 历史资料：保留当时的方案和验证结论，不作为当前产品入口或待选方案。当前约束见[项目基准](../../../PROJECT_BASELINE.md)。

# v0.14 技能用途分类与去重

2026-11-05；用户要求重新规划 `skills/`，删除重复 grill-me，并同步文件路径和依赖。对应项目基准 D12–D13；本次只整理本仓库技能资源及其调用说明。

## 分类依据

原 engineering / productivity 表达上游的宽泛分组，无法区分一个任务当前需要澄清、规划、设计、开发还是验证。现在按主要用途分为 discovery、planning、architecture、development、quality、knowledge、meta，共 20 项；详细导航见 [技能目录说明](../../../../skills/README.md)。类别用于定位，可跨类联合选择，不增加七轮筛选或强制阶段。

- discovery：grilling、grill-with-docs、research。
- planning：to-spec、to-tickets、triage、wayfinder。
- architecture：codebase-design、domain-modeling、improve-codebase-architecture。
- development：implement、prototype、resolving-merge-conflicts。
- quality：diagnosing-bugs、tdd、code-review。
- knowledge：handoff、teach。
- meta：writing-great-skills、setup-matt-pocock-skills。

上述方法名保留，目录 ID 随所属类别改变，例如旧 `engineering/tdd` 现在是 `quality/tdd`。上游来源与 MIT 不变；不回写原始参考仓库。

## grill-me 与 grilling

原 grill-me 只有一条转引 grilling 的包装说明，没有独立流程或附件，已删除，当前可选集合统一使用 `discovery/grilling`。扫描原库没有发现其它方法对 grill-me 的入链；移除的是包装自身的依赖，已有访谈入链均指向实际 grilling，并已随重分类更新路径。

grill-with-docs 保留在 discovery：它在访谈之外组合领域术语和设计决策记录，关联 `architecture/domain-modeling`。两份 description 已明确区分普通访谈与访谈加文档维护，避免选中两个重复入口。

## 路径与历史

迁移同步覆盖 YAML related、Markdown 跨方法链接、附件内链接、当前 CLI 示例和技能集成脚本。共迁移 20 个方法目录，保留 22 个附件；18 份文件的 64 处引用随位置重算，未执行方法脚本。Skill Hub 继续按实际文件发现分类，后台没有新增固定技能名单。

目录变动会改变当前 ID/指纹。尚未选择的任务应重新取 prompt 并按当前目录选择；不把旧路径自动当作新选择。已选择方案和历史仍使用当时 ID、路径、理由及归档字节，旧任务可通过归档 read 取得原文件。旧工程路径和 grill-me 名称仅可出现在来源/迁移记录或真实历史，不保留成当前候选别名。

v0.13 的 [文件适配审计](skill-hub-file-audit.md) 保留其当时 21 方法/43 文件的事实；当前变为 20 方法/42 文件，不回改历史记录。执行与文件读取边界沿用 [Skill Hub 调用说明](../skill-routing.md)。

## 验证

实际目录扫描、相对链接/关联和附件对照已完成；程序与 CLI/浏览器集成结果集中记录在 [项目基准](../baseline-history-v0.16.md) 当前实现节，避免维护多套测试结论。
