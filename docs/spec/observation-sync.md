# 只读日志观测与源码同步

- 状态：正式CLI实现契约，实际双适配器样本、合成负例和同步/平台范围见[实施状态](../implementation/STATUS.md)；v0.16有限演示不代替正式证据。
- 规格版本：1；核对日期：2026-11-06。
- 约束：D01–D09、D11–D13；验收：A02、A03、A05–A09。
- 关联：[运行架构](architecture.md)、[CLI 契约](cli-contract.md)、[模型与读取契约](model-context.md)、[存储恢复](storage.md)、[验收矩阵](acceptance.md)。

## 1. 接入与可信边界

首版由已运行的 Codex 或 Claude Code 主动调用 CLI。HarnessL3 不启动 agent、不接管模型、不安装 Hooks、不改写宿主配置；agent 仍直接用文件工具编辑源码、LikeC4 文本和依据。日志适配器只读取操作者明确绑定的现有会话文件，不执行日志里的代码、命令、补丁或技能附件。

```text
harnessl3 agent bind --agent codex --session <session-id> --log-file <absolute-log-path>
harnessl3 agent bind --agent claude-code --session <session-id> --log-file <absolute-log-path>
harnessl3 agent status
harnessl3 agent unbind <binding-id>
```

所有命令都解析到明确的项目/worktree，显式定位参数和输出形状以 [CLI 契约](cli-contract.md) 为准。bind 校验日志可读、格式与会话身份、目标 canonical worktree 和可获得的 cwd 元数据；发现冲突拒绝绑定。不得选择全局“最新 rollout”、猜测同名目录、递归扫描所有用户会话或自动接入子代理。外部技能路径可另记文件引用，不据此把另一个 worktree 的源码事件归入当前任务。

一个 `(agent, sessionId, canonical log identity)` 只能有一个活动目标绑定。同一 worktree 可显式绑定多个并行会话，事件保持独立；同一会话改到另一 worktree 时须先 unbind 再显式 bind，保留原绑定的覆盖起止和来源定位，不把旧事件转移到新目标。日志没有任务 ID 时可显示“工作区会话事件”，不按时间邻近硬塞给某个任务。

首次 bind 从所指文件起始位置补采可解析工具事件，标注 `backfilled` 和原时间；后续从检查点增量读取。unbind 停止新采集并保存覆盖终点，既有观察记录继续可查；重新 bind 同一源按检查点恢复，不能重复生成事件或延长上下文历史期限。会话不存在、日志不可读或格式不识别只影响观测覆盖，直接上下文读取继续可用。

## 2. 适配目标与事件语义

首批验收目标为 Codex **0.162.1** 和 Claude Code **2.1.212**。版本号来自当前安装目标，不代表已经实现、已验证或兼容其他版本。实现仓库为每个适配器保存脱敏 JSONL fixtures、解析器版本和已验证宿主版本表；不得用最新官方页面的示例宣称旧版日志形状一致。

解析器输出最小规范化事件：

| 字段 | 含义 |
| --- | --- |
| 身份 | `schemaVersion`、`eventId`、`projectId`、`worktreeId`、可证实的 `taskId` 或空 |
| 来源 | `agent`、`adapterVersion`、声明/检测到的宿主版本、`sessionId`、`bindingId`、日志 generation、字节区间、原记录/工具调用 ID |
| 时间 | 日志可用的发生时间 `occurredAt` 或空；服务采集时间 `observedAt`；补采标记 |
| 操作 | `read`、`search`、`write`；工具名称；规范化文件路径或搜索范围；已知行区间/返回范围 |
| 结果 | `attempted`、`succeeded`、`failed`、`unknown`；是否匹配到真实结果、退出信息类别及截断/部分返回标记 |
| 版本 | 可获得的当时内容指纹及其来源；否则 `versionStatus: unknown`，不取当前文件哈希填历史 |
| 归属与覆盖 | `matched` / `outside-worktree` / `unknown`，支持范围、未识别记录数及诊断引用 |

工具调用存在时只证明请求发生；仅当有可配对的真实结果且结果足以判断时升级为 succeeded/failed。一个工具成功并不证明返回了整个文件；搜索成功只证明搜索发生/返回了匹配，不等于每个候选文件均被读入。Bash/exec 的批量调用不从总退出码推断每个子操作成功。无结果、结果被截断或匹配不确定时保留 attempted/unknown。

文件监听只生成源码变更/新鲜度事件，不生成 agent read。成功 Edit/Write/apply_patch 可记录“工具修改成功”，但不能据此断言模型已更新或上下文已同步。日志里文件读取成功也不等于理解、模型接收确认或技能执行成功；脑图的实际 CLI 目录披露/正文返回，与日志中宿主文件操作保持来源标签，禁止混成完整因果链。

### Codex 适配器

- 对 JSONL 的 session 元数据、工具调用和结果采用固定版本解码，按 call ID 配对；跨记录保存未完成调用，结束/重启后仍未找到结果则保留 unknown。
- 支持明确文件读取/搜索及 `apply_patch` 的字面量输入；`functions.exec` / `exec` 包装只用 TypeScript AST 提取字面量 `tools.exec_command`、`tools.apply_patch` 参数，不求值、不调用 JS、不插值模板、不展开变量或函数返回值。对象按无原型字段表解码，不把继承字段作为工具参数。会话轮询只识别单一字面量 `tools.write_stdin` 的空输入、同一const结果直接交给text的严格形状，绑定内匹配原运行会话；动态ID、多调用、非空输入或打印其它值不据此更新原读取。
- 对 `Get-Content`、`cat`、`type`、`rg` 等仅识别 fixture 覆盖的独立字面量语法及有效路径。动态 PowerShell、shell 替换、管道多阶段、脚本调用和无法定位各子结果的组合命令保留 unsupported/unknown；不因命令文本包含路径就生成已读事件。
- unified exec 返回运行会话时，只有适配器可确认后续轮询与原调用的关联且获得结束结果才更新结果状态；轮询本身不生成第二次文件读取。截断标记跨各帧累积，最后一帧未截断且退出0不能抹去此前的部分输出。无法展开的嵌套工具只记覆盖缺口。

### Claude Code 适配器

- 按固定版本 transcript 的 `tool_use` / `tool_result` 标识配对 Read、Grep、Glob、Edit、Write、Bash；真实字段以脱敏版本 fixtures 验收，不将 Hook 的 PostToolUse payload 当成 transcript 格式。
- Read 可在结果明确时记录实际返回的范围；Grep/Glob 记搜索及匹配范围，不转换成全文已读。Edit/Write 仅在对应结果成功后记工具写入成功，工具错误、取消及权限拒绝保留 failed。
- Bash 与 Codex shell 共用保守字面量解析边界；多条命令、动态构造或结果不明确时不能把单一退出码传播到全部路径。
- 子代理 transcript 不因主会话引用而自动递归打开；首版仅观察显式 bind 的日志。没有可验证会话/cwd 元数据或结果配对方式时，覆盖标 unknown/partial，不静默套用新版本解析。

## 3. 增量读取、路径与覆盖

检查点保存 source identity、generation、已消费字节 offset、末尾不完整 UTF-8/JSON 行缓冲指纹、解析器版本和最后已提交观察序号。读取完整行后先提交规范化事件，再推进检查点；崩溃后允许重读，事件幂等去重。日志进度检查点和搜索索引不是原日志的替代存本。

去重优先使用绑定内可用的会话/记录 UUID、call ID、结果类型及规范化内容指纹；无稳定记录 ID 时用 source generation、字节起止和记录指纹。重读同一区间或原文件重命名不能重复；日志轮转复制的带稳定 ID 记录同样去重。缺稳定 ID 的重写文件无法证明同源重复时保留诊断和真实来源，不以猜测丢弃证据。

| 变化/故障 | 处理 |
| --- | --- |
| 活动文件继续追加、半行或多字节字符被分段 | 等待完整记录，不把尾行当格式损坏；按字节位置继续 |
| 文件同 identity 重命名轮转 | 排空原打开文件；重新打开显式绑定路径后校验 session，使用新 generation |
| 路径被不同文件替换或大小小于 offset | 记 rotation/truncation 覆盖缺口；重新校验 session，符合才从新文件起点采集，不把新 offset 接到旧文件 |
| 新文件属于另一 session/worktree | 暂停该绑定并报 mismatch，不自动重绑定 |
| 行内 JSON 损坏或不支持的记录类型 | 保存区间/错误类别/摘要指纹，继续可验证记录；整体覆盖 partial，绝不丢弃诊断后显示完整 |
| 读取权限变化、文件消失、I/O 错误 | 覆盖 error，保留最后成功位置，重试后补采；不能报告这一时段没有读取 |
| 未验证宿主版本或格式升级 | 停止对不兼容形状做成功推断，覆盖 unknown/partial；需新 fixtures 验证再扩展支持 |

路径以工具调用明确 cwd、日志中该调用可验证的 cwd、绑定工作区的可用 cwd 元数据为顺序解析；没有依据时保持 unresolved。先按来源平台语法处理 Windows 盘符/分隔符、POSIX 路径及 `.`/`..`，再使用真实文件系统 canonical/realpath 校验；不能对所有平台统一 lower-case，也不能仅凭字符串前缀判断子目录。删除的历史路径无法 realpath 时使用已记录父目录 identity 与词法边界，标注历史路径验证范围。符号链接指向工作区外时标 outside-worktree，不把外部内容当内部源码。

覆盖状态取 `unbound`、`observing`、`partial`、`unknown`、`error`、`stopped`；observing 只表示当前支持范围内持续采集，不表示全部工具覆盖。Web 和 CLI 同时显示支持工具、已观察结果数、未知/失败数、日志缺口及最后位置，不显示“100% 阅读/完整审计”。

持久记录只保留上述规范化事实、路径、标识、时间、范围、状态和来源定位/内容指纹。不要复制 prompt、聊天消息、模型思考、文件正文、整段 shell 命令或完整 stdout/stderr；解析时短暂读取原记录，未保存的内容不写诊断。排查需显式打开原日志；诊断默认只含字段名、字节区间、错误类别和摘要哈希。

## 4. 来源版本与即时待核验

源码新鲜度与模型格式有效性是独立轴：

| 维度 | 状态 |
| --- | --- |
| 模型 | `parsing`、`valid`、`invalid`；保留 `attemptedModelRevision` 和最近有效模型版本 |
| 源码新鲜度 | `unknown`、`pending`、`verifying`、`verified`、`failed`；保存验证到的来源版本及声明依据 |

watcher 收到有效源码变化立即递增该 worktree 的单调 `sourceEpoch` 并标 pending，再异步扫描来源指纹；定期 reconciliation 和 `sync status/verify` 前的扫描补偿 watcher 丢失、服务停机及分支切换。模型/依据文件变化触发解析与模型版本更新，不增加 sourceEpoch；旧 proof 的模型版本不再匹配时，当前新鲜度也回到 pending。技能根内普通文件变动只更新 catalog，不增加源码 epoch；运行数据、缓存和索引写入不触发源码待核验循环。扫描失败返回 unknown/错误范围，不沿用旧指纹冒充当前。

当前实体显式引用的本地证据文件也属于核验输入：即使被Git忽略或来源策略排除，watcher仍将该文件及受影响的引用路径标pending并推进同一代次，字节回退也不能复用旧proof；来源manifest/扫描策略不因引用而扩展。reconciliation保留成功模型加载返回的证据诊断，changed/missing/unreadable使关联范围待核验。普通未被引用的排除文件、技能和本机输出继续按原规则处理，不制造读取事件。历史模型/证据仍使用当时归档。

显式引用先于`.harness`等目录的常规分流处理，未被引用的模型文件仍遵守模型版本规则。工作区内的文件链接/junction同时登记声明路径及经过边界检查的真实目标；目标暂时缺失时保留最后安全目标用于观测重建，当前引用移除或成功改指后更新派生索引，不改写历史。不会为了观测引用而跟随越界目标或扩大来源manifest。

`sourceVersion` 固定为 `{head: string|null, treeHash: sha256|null, status: clean|dirty|unknown}`。`status` 是过滤后选定来源范围内的 Git 工作区状态，不是语义已同步：仅排除目录中的修改不把它变成 dirty，不能直接复制整个仓库的 porcelain 状态。unknown 的 `treeHash` 必须为空。`head` 为实际完整 commit，detached HEAD 保留 commit，尚无 commit 可为空；它不代表未提交内容。

<a id="source-manifest"></a>

### 4.1 来源 manifest：唯一编码

`sourceManifest` 使用以下封闭形状，字段全部必需，不接受额外字段。示例中的零哈希仅说明形状，不是已计算的真实指纹：

```json
{
  "schemaVersion": 1,
  "kind": "source-manifest",
  "content": {
    "entries": [
      {"path":"src/old.ts","entryKind":"deleted","contentHash":null},
      {"path":"src/task.ts","entryKind":"file","contentHash":"0000000000000000000000000000000000000000000000000000000000000000"},
      {"path":"task-link","entryKind":"symlink","contentHash":"0000000000000000000000000000000000000000000000000000000000000000"}
    ]
  }
}
```

- 候选路径是 HEAD 树中的 tracked 路径与 index 路径的并集，加当前未被 Git 忽略的 untracked 文件/链接；无 HEAD 时 HEAD 集为空。这样 staged 删除和尚未 staged 的删除都能形成明确条目。tracked 路径不因 Git ignore 而移除；随后统一应用固定/项目排除。
- path 为相对 worktree 的 POSIX 路径，保留实际大小写与 Unicode 字符，不做正规化，不含 `.`/`..`、空路径、绝对前缀或反斜杠。按 UTF-16 码元序严格升序排列，path 唯一；不能使用区域化排序。非法 UTF-8 路径、同路径冲突或未解决 index stages 使扫描 unknown。
- 实际普通文件用 `entryKind: file`，`contentHash` 为工作区原字节 SHA-256；不做换行、编码、Git filter 或权限位转换。实际链接用 `symlink`，哈希输入为 `readlink` 返回的链接目标字符串按 UTF-8 编码的字节，不是目标文件内容；不解析或改写该字符串。链接目标若无法无损表示为有效 Unicode，扫描 unknown，禁止用替换字符静默生成哈希。
- 对候选中的 tracked 路径，若工作区实际已不存在则用 `deleted` 且 `contentHash: null`；未跟踪文件消失则不保留 tombstone。只登记叶条目，目录、mtime、绝对路径、机器 ID、Git HEAD、扫描时间及权限位不进入 entries。HEAD 另在 sourceVersion 中保存。
- 所有目录链接、符号链接、Windows junction/reparse 链接均不跟随；链接本身作为叶条目。候选路径被链接祖先遮蔽而无法安全定位时保持 unknown，不穿过链接取目标内容。Gitlink/submodule、设备、FIFO 等 source-scanner/1 不支持条目明确诊断并令扫描 unknown；项目可显式排除其范围，不能静默当作完整扫描。

`sourceVersion.treeHash = SHA256(UTF8(JCS(sourceManifest)))`，完全沿用共享 `{schemaVersion,kind,content}` 规则。目录名/文件内容/叶类型变化会改变结果；相同路径与字节的来源在相同条目类型下有相同 treeHash，机器安装位置不参与。

### 4.2 扫描策略：唯一编码

`sourceScanRevision` 对以下封闭结构做同样 JCS/SHA-256；除项目排除、实际 Git ignore 指纹和当前 worktree 内的技能根排除外，首版值固定。示例中的零哈希仅作占位：

```json
{
  "schemaVersion": 1,
  "kind": "source-scan-policy",
  "content": {
    "scannerVersion": "source-scanner/1",
    "candidateSet": "head-index-and-untracked",
    "pathOrder": "utf16-code-unit",
    "ruleDialect": "posix-glob-v1",
    "caseSensitive": true,
    "includePatterns": ["**"],
    "fixedExcludePrefixes": [".git", ".harness"],
    "projectExcludePatterns": ["dist/**"],
    "gitIgnoreMode": "untracked-only",
    "gitIgnoreRevision": "0000000000000000000000000000000000000000000000000000000000000000",
    "skillRootExcludePrefixes": ["skills"],
    "linkHandling": "record-readlink-utf8-no-follow",
    "unsupportedEntryHandling": "unknown"
  }
}
```

includePatterns 固定 `["**"]`，不是首版用户选项。projectExcludePatterns 从配置的 source.excludePatterns 去重后按 UTF-16 码元排序；使用根锚定、区分大小写的受限 posix-glob-v1：`*` 匹配单路径段内零或多个字符，`**` 匹配零或多个字符且可跨 `/`，`?` 匹配单个非 `/` Unicode 码点；`**/` 匹配零或多个完整目录段，因此 `src/**/test.ts` 也匹配 `src/test.ts`。点文件参与。模式匹配完整相对路径；目录匹配排除其所有后代。禁止 `!` 反向规则、字符类、花括号、反斜杠、路径上跳和绝对模式；规则只排除，任何一条命中即排除。不得把它解释成完整 Git wildmatch。fixedExcludePrefixes 和 skillRootExcludePrefixes 为字面目录前缀：只匹配该路径本身或 `/` 后代，不解析成 glob。

技能根先按 [存储路径守卫](storage.md#2-目录与文件职责) 解析；位于本 worktree 内时，skillRootExcludePrefixes 保存其 proper-descendant 相对路径，多个有效根去重排序；外部根保存为空数组，不写机器绝对路径。普通技能字节改动不改变策略，根位置改变了有效内部排除前缀时才改变 sourceScanRevision；纯外部根换位由技能目录定位处理。数据根必须在所有登记 worktree 之外，因此不需要向扫描策略混入其机器绝对路径。`.git`、`.harness` 以及解析后的内部技能根均硬排除，项目模式不能将其重新纳入。

### 4.3 有效 Git ignore 规则指纹

`gitIgnoreRevision` 是以下封闭结构的 JCS/SHA-256。原生 Git ignore 继续使用原生优先级、目录规则及原有 `!`，与项目自定义排除分开；只作用于 untracked。Git 官方明确已跟踪文件不受 ignore 影响，并规定各来源与否定规则的优先级。([Git 官方说明](https://git-scm.com/docs/gitignore))

```json
{
  "schemaVersion": 1,
  "kind": "git-ignore-rules",
  "content": {
    "ignoreCase": false,
    "sources": [
      {"origin":"global","path":null,"hash":null},
      {"origin":"info","path":null,"hash":null},
      {"origin":"worktree","path":".gitignore","hash":"0000000000000000000000000000000000000000000000000000000000000000"}
    ]
  }
}
```

ignoreCase 保存有效 Git core.ignoreCase 布尔值。sources 前两项固定为有效 core.excludesFile（含其 Git 默认来源）与 Git common-dir 的 info/exclude；未存在时 hash 为 null，存在时为原字节 SHA-256，path 均为 null。随后列出实际扫描候选所适用的各级 `.gitignore`，path 为 worktree 相对路径，按 UTF-16 码元排序，hash 必须为其原字节指纹；固定排除目录中的规则不加载。原路径之外的机器配置文件名不进入内容指纹。采集这些来源时不可读、来源身份变化或无法复现有效 Git 判定时，扫描 unknown，不能以空规则替代。

规则原字节、解析后的扫描策略和 manifest 都在提交时归档，允许按指纹解释当时扫描范围；不在当前机器重新运行最新规则后冒充历史结果。每次任务绑定、来源记录和 proof 保存 sourceScanRevision；策略变化也递增 epoch 并待核验，不能以缩小扫描范围假装源码没有变化。不存在隐藏的扩展名白名单。

为了防止扫描期间变化，扫描开始/结束核查 epoch、Git HEAD/index/worktree 状态并重验变化文件；不稳定时重新扫描并返回 verifying/pending。即使当前 treeHash 与旧值相同，也要记录观测到的中间变化；旧 proof 不能跨 epoch 自动生效。实际文件系统无法提供全目录原子快照时，界面只能声称“已核验到指定版本/扫描时点”，随后变更再次待核验，不能声称永远最新。

## 5. 同步证明与阶段结束

agent 完成一个明确工作阶段后，通过原有文件工具核查影响、更新 LikeC4/证据，或记录“无语义变化”的依据，再提交 proof。阶段用调用方提供的 UUID `phaseId` 标识，本产品不推测每个模型回合都是一个阶段。

```text
harnessl3 sync status
harnessl3 sync verify --file <proof.json>
harnessl3 task close <task-id>
```

proof 字段与 [CLI 契约](cli-contract.md) 的 schema 一致：

```typescript
type SyncProof = {
  schemaVersion: 1
  requestId: string
  target: { projectId: string; worktreeId: string }
  phaseId: string
  expectedSourceVersion: SourceVersion
  expectedModelRevision: string
  sourceEpoch: number
  scope: { paths: string[]; entities: string[] }
  disposition: 'updated' | 'no-semantic-change' | 'unresolved'
  reason: string
  checks: { name: string; status: 'passed' | 'failed' | 'unknown'; evidence: string[] }[]
}
```

paths 为目标工作区内 POSIX 相对路径，entities 为模型稳定 UUID；两者至少一项非空，checks 至少一条。reason 和 checks 引用可追溯的核验/测试材料，不要求制造模型改动；proof 不携带自动执行脚本。正文工具、源码监听或成功 parse 均不能替代此记录。

服务执行以下校验与 CAS：

1. 解析 proof 与目标；来源不得 unknown，scope 必须明确本次核验范围，不能把仅一文件的核验发布为整工作区已同步。scope 超出项目/引用不存在返回明确错误；提交局部范围可以保留其核验结果，未覆盖变化仍待核验。
2. 扫描当前来源和策略，解析/校验当前模型及证据引用格式；核对 expectedSourceVersion、expectedModelRevision、sourceEpoch 与当前值。若与 task 开始时模型不同，同步校验针对当前提交的 proof，旧任务读取绑定仍不被重写。
3. `updated` 表示调用方声明已更新受影响上下文；`no-semantic-change` 表示声明核验后无需语义修改。两者仍需合法模型、来源一致、scope 覆盖及 checks 全部 passed；失败/未知 checks 或 `unresolved` 均不能变 verified。
   当前模型成功加载时的证据诊断同样保留在同步状态。被当前对象/关系引用的本地证据若 changed/missing/unreadable，其路径保持待核验；proof 的路径或实体范围命中该异常时返回 `SYNC_UNRESOLVED`，全 passed 的调用方声明不能清除此机械异常。未命中的局部 proof 可以保存，工作区仍 pending；未被当前实体引用的证据记录只保留诊断。自动检查 `referenced-evidence` 与调用方 checks 分开，不改写人工 status 或以哈希替代语义审核。
   路径范围使用声明路径和边界检查后的真实路径匹配证据及待核验项；Windows大小写等价路径一致处理，POSIX大小写不同的路径仍独立。通过其它工作区内链接进入同一文件也不能绕过证据异常；清理pending使用同一范围规则，不能因别名保留已核验项或清除无关路径。
4. 完成校验后进入 worktree 写队列，再核查实际来源指纹、模型版本、策略和 epoch，不仅比较缓存；通过才提交 proof、自动校验结果和验证到的版本/扫描时点。异步期间观察到新变更则拒绝旧 proof，保留 pending 并返回最新版本供重做，不能用最后写入者覆盖新状态。提交后检测到的变化立即使该 proof 成为历史核验点，不继续标当前 verified。

scope 可核验一部分变化：保存局部 proof，但只有所有待核验路径均被覆盖且当前版本/epoch 一致，工作区才是 verified；剩余范围继续 pending。语义影响范围由提交者声明并记录，不伪装成服务已经自动理解。路径/哈希匹配、模型有效、测试通过分别显示，自动校验结果和调用方语义声明分开保存。

`invalid` 模型使同步不能成功，Web 展示当前诊断，可继续看明确标为旧版本的最近有效图。proof 校验失败保存原因和核验目标，freshness 标 failed；来源继续变化后为 pending。`sync status` 只查询/刷新当前事实，不自动把旧 proof 升级为最新，也不运行模型推理或修改文本。

`task close <id>` 表示停止给该上下文组织任务追加 select/context query，记录 `closedAt` 及同步状态摘要；task read 读取已归档技能文件仍允许。待核验或失败时仍可关闭并明确 `pending/failed`，不冒充“阶段语义已完成”；只读查询与历史恢复仍允许。它不结束 agent 进程、不证明技能执行结束，不因关闭延长历史期限。

## 6. 必须验收的场景

- 两种目标版本分别采集脱敏 fixtures：成功/失败/取消/无结果、搜索匹配、部分 Read、写入与嵌套 exec；未识别动态命令不产生成功读取。
- 两个 worktree、相同文件名、两个并行 session、无任务 ID、错误 session/cwd、跨界路径及显式外部技能引用不会串归属。
- 中文/空格/盘符/大小写/链接路径；日志追加半行、UTF-8 分段、重启重读、轮转、截断、替换成另一会话、解析器升级，去重与缺口状态真实。
- 日志只读，原文件/宿主配置字节不变；采集目录不包含聊天/正文/原始命令/完整输出；日志字符串没有被执行。
- watcher 写入只标源码变化、不计已读；版本未知事件不取当前内容补造；CLI 返回和宿主日志两条来源分别呈现，未采集部分仍未知。
- 合法模型与 dirty 来源独立显示；未提交/未跟踪/删除、Git 分支变更、排除策略修改、停机间隙、扫描失败均不误报 verified。
- 同一来源 manifest 的 JCS/哈希跨平台复算一致，UTF-16 路径排序、staged 删除、链接目标修改、非法 Unicode 和不支持条目均有固定正反例；Git ignore 与项目受限 glob 的语义不混用。
- 项目内部技能根被固定排除；编辑/增加/删除普通技能仅更新 catalog，不改变 sourceVersion 或 sourceEpoch；根位置改变内部排除集时策略/epoch 变化，旧 proof 被拒绝。
- updated/no-semantic-change/unresolved proof、失败/未知 checks、局部范围、模型无效、错误 proof 绑定、验证期间再次写入、相同字节回退但 epoch 增加，均验证 CAS 与真实状态。
- 关闭未同步任务保留 pending/failed，历史/skill read/日志补采不续期，重建观测索引不重复事件或改变证明。

以Node内置测试验证解码/归一化/状态机，临时worktree及故障注入核对监听/重启，Playwright检查来源标签/未知提示；三平台分别运行，不能凭Windows结果宣称跨平台支持。上述为完整要求，实际已执行的子范围单独记入实施状态。

## 7. 资料与实施风险

核对日期为 2026-11-05。Codex 官方提供 `transcript_path` 作为便捷定位，但明确说明 transcript 格式不是稳定 Hook 接口且可能变化。因此首版依靠固定版本 fixtures、版本表和诚实降级，不能把此路径视作稳定采集协议。这里只使用文档解释来源限制，不安装任何 Hook。([Codex 官方说明](https://learn.chatgpt.com/docs/hooks))

Claude Code 官方 Hook 文档的公共字段包含 session、cwd 和 transcript_path；这仅支持会话日志存在及定位的依据，不能据此保证 transcript 内部结构。正式实现仍必须取得 2.1.212 的脱敏工具调用/结果样本验证，不能把较新 Hook 示例直接当旧 transcript schema。([Claude Code 官方说明](https://code.claude.com/docs/en/hooks))

日志格式升级和各平台轮转行为属于实施期兼容验证；格式不匹配的处置已在本规格写定，不阻止 CLI 的直接文本/上下文读取。文件 watcher 的覆盖和指纹扫描开销须实测，首版不承诺数值延迟或完整语义同步。新增 agent、自动会话发现、Hook 采集、启动 agent 或执行技能均需另行范围决策。
