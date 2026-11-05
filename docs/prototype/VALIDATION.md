# 原型验证资料与局限

2026-11-05冻结。此页整理此前实际执行的检查；本轮文档/GC核查另见[清理记录](CLEANUP.md)，不将它们重记为正式CLI验收。

## 保留的证据

| 资料 | 实际范围 |
| --- | --- |
| [脑图报告](validation/mindmap-report.json) | 最近完整16项Edge集成通过，含五类、批量返回、折叠/SSE、鼠标/触摸、包与证据 |
| [技能报告](validation/skills-report.json) | 最近10项CLI/HTTP/Edge集成通过，含文件夹/skill/文件逐层、点击锚点、自动新增删除分类、归档和手机 |
| [历史报告](validation/history-report.json) | 最近8项历史CLI/HTTP/Edge集成通过，含只读批次、冻结SSE、历史C4和手机 |
| [原分类核查](validation/original-category-check.json) | v0.13真实任务仍显示engineering与原ID，skillPlan/批次/updatedAt浏览前后不变 |
| [Slate对比度](validation/slate-contrast.json) | 指定颜色组合的计算，不是所有缩放/透明叠加的可访问性验收 |

v0.16另实际通过完整45项程序测试和TypeScript/Vite构建；v0.14/v0.15的43项测试数量保留其历史语境。上述JSON报告中的旧临时路径仅为执行时记录，不是当前文件导航。终版截图保留在assets；不需要保留每次调试生成的所有副本。

MGRP主模型版本为`75709765b1f4feff0d4975b493390cb09350dd334f8166881da7def18d91be02`；原型记录40对象、32关系、5视图，74条证据/42文件核对有效。该结果针对所引来源，不证明整个业务项目已语义同步。

## 已知问题 V-P01

v0.16回归时，`scripts/check-browser.mjs`的缓存重试用例首次出现`unchanged.length`为0、期望1；完整复跑16项通过。未修改该逻辑，也未核定偶发原因，不能称问题已解决。

正式实现应先在隔离的数据根/服务上复现，等待真实请求完成并检查请求中的known指纹、对应批次与UI加载代次。必须定位根因并给出失败→通过证据，或明确独立隔离该不稳定用例，才把它作为发布门禁。不能通过增加固定睡眠或无上限重跑伪装稳定。

## 不能从这些结果推断的能力

- 不是正式多项目/worktree产品、完整Codex/Claude适配或通用agent启动器验收。
- 60天边界使用可控时钟，未实际连续运行60天。
- 没有验证全量工具覆盖、模型理解、技能执行、所有源文件同步或正式性能SLA。
- 原型的Codex来源发现仍有“最近日志”假设，正式规格要求明确绑定，不能原样移植。
- 原型未使用SQLite派生索引；该部分是正式开发目标。

历史实现与每轮检查保留在[原基准历史](archive/baseline-history-v0.16.md)，正式待执行场景见[验收矩阵](../spec/acceptance.md)。
