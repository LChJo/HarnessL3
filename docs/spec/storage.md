# 本机存储、事务与历史恢复

- 状态：正式CLI首版实现契约；实际模块和平台验证见[实施状态](../implementation/STATUS.md)，不把v0.16原型报告当正式验收。
- 规格版本：1；核对日期：2026-11-07。
- 约束：D05–D09、D12–D13；验收：A01、A02、A09、A10。
- 关联：[运行架构](architecture.md)、[CLI 契约](cli-contract.md)、[模型与读取契约](model-context.md)、[日志与同步](observation-sync.md)、[验收矩阵](acceptance.md)。

## 1. 数据权威与身份

业务仓库中的 `.harness/project.json`、`model/*.c4` / `*.likec4`、`evidence.json`、`aliases.json` 是可维护的长期上下文。普通技能仍是技能目录中的文件。运行服务读取这些文件，派生目录、模型投影和索引；数据库不提供第二套可编辑对象，也不把读取历史写回业务仓库。

Git项目的入口筛选提示应建议将`.harness/model/`内的`.c4`/`.likec4`（含specification与views）、`.harness/project.json`、`.harness/evidence.json`、`.harness/aliases.json`与相关源码变更一并版本管理。引用的长期项目文档，以及仓库内以真实文件维护的项目技能、附件和许可证，也按项目规则提交。项目UUID及可移植相对配置随Git保存，机器绝对路径、worktree登记与访问凭证不纳入。

本机数据根中的journal、任务、快照、归档技能字节、SQLite索引、缓存/布局和日志不随源码提交；项目已有的本机输出目录同样按其用途排除。历史与用户技能仍须保留，Git排除不构成删除授权。默认全局技能库及其symlink/junction入口、外部目标不因这条建议被复制或纳入仓库。提示仅提供提交范围建议，暂存、commit和push遵守用户已有授权。

项目使用随 Git 保存的 `projectId` UUID；本机登记为每个已有 worktree 分配 `worktreeId` UUID，并绑定解析后的绝对路径和 Git common directory。分支名、HEAD、目录拼写均不是主键。分支变化保留 worktree 身份，但重新计算版本并将已有任务保留为原绑定；路径移动必须通过登记流程显式重新定位，不能自动把另一目录的记录接上。取消登记只停用本机绑定，不删除源码目录、任务和快照。

已停用登记仍保留其 UUID 归属和档案定位，显式 worktree UUID 可执行 history list/show、task show/handoff/read；只读档案不要求原目录、HEAD 或当前模型仍存在，仍校验目标归属和完整性。停用目标不能 prompt/select/query/sync 或重新开始活动任务；需重新核验登记后才能处理当前源码。

每个任务冻结 `projectId`、`worktreeId`、模型版本、来源版本和来源扫描策略版本。尚未联合选择时，`task prompt` 可按实际技能目录更新 `catalogRevision` 与筛选材料；`task select` 提交后，技能目录版本、所选 group/ID/文件字节随该方案冻结，后续刷新不改写。历史可保留当时的路径和分支标签，查询不能据此隐式切换 Git 分支。两项目使用相同相对路径、两 worktree 指向相同 HEAD，均不能共享运行状态。

sourceVersion、sourceManifest、sourceScanRevision 的唯一形状与排序见 [来源指纹规范](observation-sync.md#source-manifest)，此处不另造编码。普通文件按实际工作区原字节哈希，不能以 Git blob 或当前索引替换历史内容。

## 2. 目录与文件职责

数据根按以下顺序确定：显式 `--data-dir`、`HARNESSL3_HOME`、平台默认值。平台默认值为 Windows 的 `%LOCALAPPDATA%/HarnessL3`、macOS 的 `~/Library/Application Support/HarnessL3`、Linux 的 `$XDG_DATA_HOME/harnessl3`，Linux 未设置该变量时为 `~/.local/share/harnessl3`。显式配置必须为绝对路径。数据根与每个已登记 worktree 的目录树必须互不包含：不能相等，不能位于 worktree 内，也不能成为 worktree 的祖先。服务启动、init 和登记新 worktree 均核查 canonical/realpath；尚未创建的目录先解析最近存在祖先后再补路径组件。冲突明确拒绝，不隐式迁移数据或通过添加排除规则绕过守卫。

同一用户、同一 canonical 数据根只运行一个服务实例；不同显式数据根用于独立实例和测试，不共享 registry、锁或任务。服务启动后固定其数据根，不随请求环境变化。数据根只在运行架构的本机单写约束内使用，不作为项目源码扫描的一部分。

```text
<data-root>/
  registry.json
  skills/
  worktrees/<worktreeId>/
    journal.jsonl
    tasks/<taskId>.json
    snapshots/<sha256>.json
    skill-blobs/<sha256>
    index.sqlite
    checkpoints/
    cache/
```

| 内容 | 职责及恢复依据 |
| --- | --- |
| `registry.json` | 本机登记、canonical path、Git common directory、停用状态；原子替换，机器路径不随 Git |
| `skills/` | 默认的机器全局用户可编辑技能来源，包含方法、附件与许可；不是缓存，不能重建覆盖用户编辑 |
| `journal.jsonl` | 按 worktree 单调提交序号保存任务、批次、读取回执、绑定、观测、同步及迁移提交；运行历史的提交依据，只追加 |
| `tasks/<id>.json` | 任务当前物化结果，含最后提交序号和校验值；从已提交日志与归档重建，不接受 CLI/Web 直接编辑 |
| `snapshots/<sha>.json` | 不可变的当时模型、关系、依据、C4 数据、批次结果及协议响应；按 `kind` 区分用途，不借当前内容补旧历史 |
| `skill-blobs/<sha>` | 当时所选技能及附件的原始字节；按原字节校验，不因目录迁移重新写历史 ID/group |
| `index.sqlite` | 本 worktree 的派生索引；丢失、格式升级或损坏均可重建，不作为任务或运行事件的唯一存本 |
| `checkpoints/` | 日志读取位置、已提交序号及恢复加速点；检查点失效时回退重放，不改变已经观察到的事实 |
| `cache/` | 解析、目录、查询与布局缓存；带输入指纹和生成器版本，可删除重建 |

JSON 使用 UTF-8、无 BOM。所有记录带 `schemaVersion: 1`；结构指纹统一为 `SHA256(UTF8(JCS({schemaVersion:1,kind,content})))`，由共享 core 的 RFC 8785 canonical JSON 实现，拒绝重复键、非法 Unicode 和非有限数，不改变字符串正规化。文件内容指纹直接计算原字节 SHA-256；全部为小写 64 位十六进制。快照外层的捕获时间及校验字段不加入其自身指纹。禁止通过反序列化后随意 `JSON.stringify` 改写旧快照。

本机文件按当前用户权限创建；运行服务是唯一写入者。CLI、Web 和 SQLite worker 通过服务协调，不各自读改写任务文件。数据目录不支持放在网络共享盘上进行多主写入；本机复制出的历史目录也不能作为第二个活动写入端。

技能根解析顺序为 `HARNESS_SKILLS_ROOT`、项目 `.harness/project.json` 的 `skills.root`、`<data-root>/skills`；项目配置路径相对当前 worktree 解析。首次init仅在默认技能根不存在时，将随包21项方法、附件和LICENSE完整复制到同级`.skills-library-<UUID>`持久实体，通过独占创建symlink（Windows junction）原子发布skills入口。POSIX入口使用相对目标，Windows junction使用绝对目标；不使用会替换既有空目录的rename作为发布。发布失败只清理本次创建且能证明未被入口引用的实体，不能确认时保留。已有目录即使为空或并发出现也不合并、不覆盖；升级包不改用户正文。实体是活动用户技能库，不在GC删除范围。入口及实体内仍是普通可编辑文件，刷新只重建目录和诊断，与`skill-blobs`历史副本职责分开。

项目配置的技能根必须是当前 worktree 的 proper descendant，不能等于根或通过链接逃逸。所有技能根都不能等于或包含 worktree 根，不能位于/包含其 `.git`、Git common directory、`.harness` 或运行档案目录；机器数据根内只允许专用 `<data-root>/skills` 及其子目录作为技能来源，不能把整个数据根、registry 或 `worktrees/` 当技能目录。上述检查使用解析后的实际路径；用户目录不存在时同样先核对最近实际祖先。项目内技能根按相对 worktree 的字面前缀固定排除来源扫描，写入 `sourceScanRevision`；普通技能文件修改仅更新 catalog，不增加源码 epoch 或触发 `SOURCE_CHANGED`。根位置配置改变了有效内部排除前缀时，扫描策略改变并需重新核验；纯外部技能根换位不把机器绝对路径混入源码指纹。

## 3. 提交、幂等与崩溃恢复

每个 worktree 有独立的写队列；同一队列串行提交，独立 worktree 可并行工作。读取与哈希可在队列外计算，入队时必须重新核查目标、模型/目录版本及 CAS。长时间日志读取、模型解析和 SQLite 查询不占用提交队列。

所有改变运行记录的请求携带 UUID `requestId`。服务计算规范化请求指纹，并在日志中保存幂等结果：同一 task 内（创建请求则为同一目标 worktree）、同一 `requestId`、相同请求返回第一次提交的归档正文；JSON 封套首返 `replayed: false`、幂等回放 `replayed: true`，重放标签不进入原归档正文和内容指纹。相同 ID 配不同请求拒绝为幂等冲突，不重读新内容、不重复选择、不续期。请求执行中重试只等待该请求结果；网络断开不撤销已经提交的批次。

一次提交顺序如下：

1. 校验目标身份和请求版本，捕获本次实际准备返回的内容。把新快照、结果回执及技能原始字节写入同目录临时文件，刷新文件后原子安装到内容寻址路径；已存在的同指纹文件必须通过校验。
2. 构造一条自足的 commit 记录：`schemaVersion`、`seq`、`operationId`、`requestId`、请求指纹、目标/任务/批次 ID、提交时间、增量、回执引用及新增归档引用。记录带前序记录指纹与自身指纹；`seq` 在 worktree 内严格递增。
3. 追加带换行的完整 commit 并执行文件同步；此时事务生效。提交前需要引用的归档已落盘，不能先记成功再补文件。
4. 原子替换任务物化文件，向 SQLite worker 投影到相同 `seq`，更新检查点，再发布 Web 事件及 CLI 回执。回执的成功表示服务已提交返回内容，不证明宿主模型已接收、理解或执行。

`registry.json` 的全局登记写入另有短队列和原子替换；它不跨 worktree 修改任务。进程互斥由运行架构的单实例锁保证，不能仅靠 SQLite 文件锁替代服务锁。

| 中断位置 | 重启行为 |
| --- | --- |
| 归档临时文件未完成，尚无有效 commit | 尚未提交；可辨认的未提交 staging 标记为可清理，同 requestId 重试可正常执行 |
| 归档完成，尚无有效 commit | 尚未提交；内容作为未引用孤立归档保留，同 requestId 可重做；不能反向推断读取或选择已发生 |
| commit 已同步，任务或索引未更新 | 从已提交 `seq` 重放投影；同请求重试返回原回执 |
| SQLite 更新失败或文件丢失 | 标记 `index: rebuilding/degraded`，保留提交；任务按 ID 可由日志/任务文件读取，搜索索引完成前明确不可用，不返回假空列表 |
| 日志尾部为未完成的一行 | 保留原始尾部诊断副本，仅恢复到最后一个通过校验的完整 commit；不把半行当成功事务 |
| 日志中间损坏、序号缺口或前序指纹断裂 | worktree 进入 `recovery-required`，停止新的运行写入；保留文件并提供已验证范围，不能跳过损坏记录后宣称完整恢复 |
| 有有效 commit，但其快照/技能字节缺失或不匹配 | 提交结果的完整性受损，返回 `ARCHIVE_CORRUPT`；不重新执行选择、不下载新技能或用当前模型替换，其他可验证档案继续只读 |

文件同步及原子替换的具体实现必须在三平台做故障注入验收；不宣称可抵御任意硬件故障。Windows 的目标占用/替换失败要报错并保持旧文件可读，禁止先删除有效目标再尝试写入。日志恢复不能通过重放业务读写命令完成，重放只投影已经记录的结果。

没有有效 commit 的首次选择不能被锁成 `SELECTION_UNKNOWN`。该状态只用于 legacy 或已经保存、但事实仍无法确定的旧记录；禁止覆盖这类未知方案。正式事务按“无 commit 未提交、有完整 commit 回放、有 commit 但档案损坏报错”处理，不以客户端没有收到应答推断未知。日志自身中间损坏仍先进入 recovery-required，不能将不可验证区域当成无 commit 后重做。

## 4. SQLite 派生索引

首版使用 Node 24 工具链的 `node:sqlite`，通过独立 worker 和窄接口封装同步数据库调用；服务主线程不直接执行同步 SQL。worker 只接受固定的索引/查询消息与绑定参数，不接受来自 CLI 或 Web 的任意 SQL。

首版投影覆盖：worktree 内任务目的/ID/声明会话/模型版本/活动日期、批次顺序、实际披露和读取的实体 ID、技能选择引用、观测事件与同步诊断。对象和关系的当前查找索引由 `.c4` / 证据文件派生；五类信息共享同一实体索引，不存五套可维护对象。

索引元数据保存 `schemaVersion`、投影器版本、输入模型/目录版本、最后应用 `seq`。每个 commit 的投影在 SQLite 事务内完成，主键包含其真实归属，重复应用相同 `seq` 无副作用。启动检查索引版本与完整性；不兼容时关闭连接、隔离旧派生文件、从权威文本和有效日志构建新库，完成后替换。重建不得更改日志、任务时间、快照字节或历史 ID。

模型缓存键包含模型版本和解析器版本；布局另含视图、布局引擎版本及显示参数。技能目录缓存键包含实际目录指纹；历史读取只用其归档引用。不能因为当前缓存命中而省略本次实际返回回执，也不能把打开 Web 的展开操作计成模型正文读取。

Node 24.12.0 官方将 `node:sqlite` 标记为 Stability 1.1 / Active development，`DatabaseSync` 接口同步执行。必须锁定实际验收的 Node 补丁版和适配器测试，不把 LTS 标签当成该 API 已稳定的保证；后续版本状态变化也不代替重新验收。选择该 worker 边界是兼容与阻塞隔离设计，不是已证明的性能优势。([版本化官方文档](https://nodejs.org/download/release/v24.12.0/docs/api/sqlite.html))

## 5. 任务快照与 60 天窗口

任务开始保存初始轻目录及其版本；每批实际披露/返回保存不可变结果和引用。按批次恢复时按已提交顺序截断累积到所选批次，忽略之后的新读取、实时目录与模型变化。上下文输出是当时服务返回的包；技能选择和按需读取分别记录。没有采集的宿主聊天和最终代码产物不自动归档。

快照保存当时模型/关系、来源和证据引用、版本、五类投影所需材料及按需 C4 视图数据；技能保存选择时的 ID、group、路径、文件清单及字节。原始源码不默认复制；历史源码按钮若打开当前文件，必须标注当前预览，不能声称是当时片段。

正式记录分开保存：

| 字段 | 含义 |
| --- | --- |
| `createdAt` | 上下文组织任务首次提交时间 |
| `updatedAt` | 最后一次任务记录变动；绑定、关闭等不能据此延长历史窗口 |
| `lastReadAt` | 最后一次成功或部分成功、且至少实际返回一个上下文目录或正文目标的提交时间；无读取时为空 |
| `retentionBasisAt` | `lastReadAt`，无读取时为 `createdAt`；迁移特殊处理见下一节 |
| `expiresAt` | `retentionBasisAt + 60 × 86400000ms`，按 UTC 绝对时长计算 |

默认历史搜索包含 `now <= expiresAt` 的任务，恰好 60 天仍在窗口内，仅 `now > expiresAt` 才超期退出默认窗口；按日期过滤使用同一个活动基准。浏览/复制旧包、恢复批次、`handoff` 重取既有回执、skill `read`、日志补采、task close、索引重建和幂等重放均不续期。失败或未返回任何目标的批次不续期。实际追加上下文读取可以更新 `lastReadAt`，但不能追加到已关闭或超期的任务；继续工作需新建任务。

超期只退出默认发现窗口；已知任务 ID 仍可只读查看，响应明确 `expired: true`。禁止自动重新激活、清空或永久删除超期任务。关闭任务仅结束上下文组织阶段，不表示宿主 agent 停止执行；关闭时原同步待核验或失败状态必须继续显示。

旧任务完全没有对应快照时，仅从其保存的真实响应恢复已知目录/正文/引用，返回 `partial` 和未知范围；不匹配的现存快照属于 `corrupt/missing` 错误，不能降级伪造为“从当前内容恢复”。

## 6. 原型数据迁移与格式升级

迁移使用显式来源目录和显式目标 worktree，先只读生成清单，再由 `--apply` 提交复制；命令和 JSON 输出见 [CLI 契约](cli-contract.md)。不把 `.harness-local` 目录里的 MGRP 名字或旧路径哈希当成正式项目 UUID。操作者需确认来源与目标对应；迁移不创建/切换 worktree，也不删除或重写原型源文件。

1. 枚举原型 task、context snapshot、选中技能归档，验证 JSON、引用闭包及原有哈希；原始文件另以原字节指纹纳入迁移 manifest。运行中来源必须先停止写入，或在扫描结束重新核对 manifest；变化则整次 apply 拒绝并重新预览。
2. 保留原任务/批次 ID、时间、模型与技能 ID/group/字节。原型 `updatedAt` 原意为读取活动，直接保存为 `legacyRetentionAt` 和初始 `retentionBasisAt`；合法值不能回填为导入时间。旧记录无合法活动日期时保留 unknown，并退出默认日期检索，仍可按已知 ID 查诊断。
3. 正式项目/worktree ID 是新登记身份；同时保存原 `projectId` / `worktreeId`、来源目录指纹与 `legacyBinding`，不冒充旧会话当时已被正式系统绑定。旧源码状态仅有证据文件哈希时保留其有限范围，不制造完整 `treeHash`；缺失的 `sourceScanRevision` 为 null，不取当前策略回填。
4. 迁移结果为 `kind: legacy-archive`、`format: prototype-v0.16`，保存 `completeness`、`throughBatchId`、原有 `record` 和已知/未知绑定字段；用 `kind: legacy-raw` 的快照保存原文件字节的 base64 及原始指纹供核验。旧 dot ID 不伪造成正式 UUID，旧指纹不因新 canonical JSON 规则改变其含义；新增外层快照指纹另计算。缺快照保留 partial；损坏记录逐项列出并阻止该条导入，不以新内容修复。
5. 迁移 ID 由规范化来源身份、源文件 manifest 和目标身份计算；提交日志记录导入清单。重复相同迁移为幂等跳过。目标 task ID 已存在且来源内容不同则冲突，保留两侧数据并报错，不悄悄覆盖或换 ID。

`history`、`task show`、`handoff` 可只读返回 legacy envelope，但不能对旧档案执行正式 `context query`、重新选择或追加读取；后续工作必须创建严格 v1 绑定的新任务。不因可展示旧记录就宣称它符合正式实体身份或同步协议。

首版不对已有正式历史做原地批量重写。格式升级通过版本化解码器读取旧记录，派生索引可重建；需要不兼容迁移时先导出预览和验证源完整性，再另行提供显式迁移版本。读取不支持的新 schema 返回版本错误，不忽略字段后冒充兼容。

## 7. GC、诊断与验收

正式 `gc` 默认 dry-run，只有 `--apply` 才删除清单中的已失效缓存、可重建索引副本和可确认未提交的 staging 文件。每项记录所属 worktree、解析后的绝对路径、大小、引用依据与可重建方式；apply 前重新核对服务锁、引用和路径仍在数据根内，发生变化则跳过并报告。活动 worker/请求正在使用的文件不能删除。

任务、日志、快照、用户可编辑技能库、技能 blob、未知用途文件与迁移原件一律不在首版 GC 删除范围，包含超期和孤立档案。取消登记不是清理授权。自动备份和历史永久 purge 继续范围外，不用“节省空间”推定删除授权；重建索引不等于能恢复丢失的历史。

实现验收必须覆盖：

- 三平台数据根、中文/空格路径、大小写与符号链接解析；同路径名项目及双 worktree 隔离。
- 数据根与新/已有登记 worktree 的祖先、相等、子目录冲突均拒绝；用户技能来源与运行档案不能重叠，默认 data-root/skills 可编辑且不会被 GC。
- 同 requestId 重试、同 ID 异请求冲突、并发读取后版本 CAS 失败；各提交步骤断进程后的恢复和原回执重放。
- 删除/破坏 SQLite 后重建，任务/快照/时间字节不变；日志中间损坏停止写入，尾部未提交与归档缺失各有明确结果。
- 模型/技能后续编辑、删除、重分类后仍能恢复历史批次、C4 和当时文件；旧无快照 partial，损坏不补造。
- 可控时钟覆盖 60 天前/等于/之后、浏览及技能读取不续期、部分返回与全失败、迁移活动日期不回填。
- GC dry-run/apply 清单一致；超期任务、历史及技能 blob 零删除；源路径或引用在预览后变化时停止相应删除。
- 记录冷启动、热查询、重建耗时和空间规模；首版无预设数值 SLA，依据 A10 的实际测量确定后续预算。

上述定义完整测试目标；实际故障注入、平台和包验收范围见[实施状态](../implementation/STATUS.md)。未运行部分不从文档自洽检查推定通过。
