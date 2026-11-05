# 性能基线（TC17）

这是 D07 / A10 / FR14 / TC17 的实施测量记录；正式验收状态见 [STATUS](STATUS.md)。本轮建立可重复运行的本机基线，不定义 SLA，也不以局部微基准代替完整 CLI 延迟。

## 本轮结果

<!-- PERFORMANCE_RESULTS -->
最终四规模测量正在运行，尚未形成完整基线。准备期 smoke 和修复前中断样本不作为最终结果。
<!-- /PERFORMANCE_RESULTS -->

## 输入与隔离

[生成器与运行器](../../scripts/v1/benchmark.mjs)只构造合成数据。`synthetic-mgrp-scale` 复用 40 对象 / 32 关系 / 5 视图的数量，不复制 MGRP 业务模型或源码；另外生成 100、1000、10000 对象的八叉分层结构。对象、关系、证据和历史索引行使用固定种子生成身份。普通技能为 7 组、20 项、40 文件，均为无业务内容的可编辑文件。

每个视图最多显式包含 12 个对象；真实布局节点/边数由 LikeC4 返回并写入原始样本。10000 对象的模型解析结果不能当作 10000 节点同时渲染的证据。

所有仓库、原生 Git 测试 worktree、注册记录、技能、伪造日志、任务、归档和损坏 SQLite 均在同一自有 OS 临时目录。Git 命令只在夹具准备阶段创建两个测试 worktree；产品调用只登记已有 worktree。测量不读取真实业务源码、用户会话日志或 85 份真实历史，不更改项目真实分支。结束后通过独占 data-dir 停止自有服务，核对临时目录边界再清理；无法确认服务停止时保留夹具供恢复。

## 计时口径

CLI 三类为实际子进程到返回 JSON 的端到端计时：服务启动、目标定位，以及 `task start` 加一次联合 `context query`（展开一层并读取四个跨层对象）。冷态在每次样本前确认服务停止；热态复用现有服务，但每次仍启动新 CLI 客户端。停止前置条件失败单列为失败，不冒充冷态。客户端/服务 RSS 通过仅本次子进程使用的 preload 每 250ms 采样，并在进程退出时读取 lifetime peak；采样本身存在开销。

其余为调用实际产品模块的微基准，计时不含子进程启动和模块导入。冷态每次创建新的 Node 子进程；热态先执行一次未计入统计的预热，再在同一进程执行三个样本。OS 文件缓存不强制清空。每组都保留原始毫秒、成功/失败、峰值 RSS、磁盘数据和前后 backend/lock/运行器指纹。

| 微基准 | 实际测量范围与准备边界 |
| --- | --- |
| `model-load` | LikeC4 解析、模型投影与五个有界视图布局；核对实际对象/关系/证据/视图数量。 |
| `mixed-read` | 已加载模型的两组目录与六个跨层正文投影；不含解析、来源指纹、提交或 CLI 传输。 |
| `source-reconciliation` | 正式来源扫描和 Git 身份/状态核对。 |
| `skill-scan` | 实际目录发现、技能/附件读取与指纹。 |
| `sqlite-rebuild` | 从全部合成文档重建派生索引。 |
| `sqlite-project` | 索引与 worker 在计时前初始化；每次修改十个文档的文本/数据再增量投影。冷态表示新进程，并非未初始化索引。 |
| `sqlite-corrupt-rebuild` | 先关闭 worker，再损坏仅此夹具的 SQLite；测量隔离损坏文件、重开 worker、全量重建及历史数量核对。每次都重开 worker。 |
| `archive-recovery` | 60/100 条小型提交的哈希链、引用和物化恢复，再重放最后回执；不是完整 TaskService 历史包规模测试。数据准备在计时前写入，热态复用已恢复的 Archive。 |
| `log-backlog` | 合成 Codex 日志的构造/写入、解析、路径验证、脱敏事件快照、fsync 提交和 checkpoint；另列 binding/commit 子阶段。每次新建绑定、manager 和归档，热态只复用进程/导入。 |
| `sync-status-and-proof` | 实际扫描、状态与 `no-semantic-change` proof 的机械校验/提交。合成说明不证明业务语义正确。 |
| `dual-worktree-concurrent` | 两个测试 worktree 并发执行真实模型解析/布局、来源扫描和精确正文投影；不等同于两个 CLI 服务同时冷启动。 |

每类每温度三个样本。P50/P95 采用成功样本的 nearest-rank；仅三个成功样本时 P95 就是最大值，不能据此估计稳定长尾。失败原样保留并单列失败率，不进入成功延迟分位数。内存为进程 lifetime peak，包含准备/导入及之前热态样本，并非单次调用的增量内存。磁盘是观察时点的普通文件字节数，不是分配块数或原子替换期间的瞬时峰值。微基准的 scratch 字节和 CLI 累积 machine-data 字节不是相同口径。

技术超时由原始报告记录：默认每条 CLI 命令 300000ms、每个微基准子进程 300000ms（热态包含预热与三个样本）。这只是测量进程上限，不是产品数值 SLA；超时会作为失败保留。

## 复现与证据

在已安装依赖的源码仓库中运行：

```sh
npm run build:cli
node --test tests/v1/benchmark-fixtures.test.mjs
node scripts/v1/benchmark.mjs --scales 40,100,1000,10000 --samples 3 --label frozen-windows-baseline --output .harness-local/implementation-20261105/performance-windows-baseline.json
```

可用 `--only model-load` 等项目名缩小诊断范围；完整 CLI 组使用 `--only cli`，`--timeout` 调整微基准子进程上限。正式结果须保留实际参数，不能把重试、超时或较小规模替换后仍沿用原结论。

生成器行为先出现真实 RED（非法种子缺少预期异常），修正后五项 GREEN，包含固定种子/层级/规模、安全写入、失败统计，以及实际 LikeC4 的 40/32/5 加载核对。正式性能结果来自真实运行，不由这些单元测试推断。

原始 JSON 保存在本机忽略目录，包含每个样本而非只有汇总。准备期的 `performance-windows-40.json`、`performance-smoke-model.json`、`performance-smoke-large-model.json` 与 `performance-windows-pre-bind-fix.json` 单独留存；最后一份是修复日志绑定幂等边界前按要求中断的 24 组 / 72 样本 checkpoint，已停止服务并清理自有夹具。它们不与最终样本合并。

## 限制

本机与 Windows 回归、Linux 原生验证共享资源，后台工作会影响结果；没有隔离 CPU/内存/磁盘负载。未强制清 OS 页缓存，也未将物理磁盘列表映射到夹具卷，因此不猜测该卷的介质。Windows 的这一组测量不能代替 macOS/Linux 性能或兼容性验证。

事件提交到浏览器实际显示的延迟不由此脚本测量，需另行 Playwright 证据；正文投影微基准不包含模型解析、归档、来源核对或浏览器渲染。当前数据只用于识别后续应分析的慢路径，不能宣称最优或达到尚未约定的性能预算。
