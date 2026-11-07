# 模型、身份与批量读取 v1

状态：**正式实现契约**，实际代码/平台范围见[实施状态](../implementation/STATUS.md)。LikeC4 `.c4` / `.likec4`是对象、关系、说明和视图权威；JSON只存项目标识、显式别名和证据，不维护第二套对象数据。agent继续使用原有文件工具读写。本文落实D01–D11/D13与A03–A07；任务/文件入口见[CLI契约](cli-contract.md)。

## 1. 受管理目录

```text
<existing-git-worktree>/
  .harness/
    project.json      # Git：projectId、名称、来源排除及可选技能路径
    model/            # Git：LikeC4 specification / model / views，按职责分文件
    evidence.json     # Git：依据标识、位置、声明及核验指纹
    aliases.json      # Git：显式旧对象定位 → 持久 UUID
  ...source files...
```

`init`只生成最小合法模板并做机械接入，返回scaffold-ready、当前模型数量及语义not-assessed。当前大模型随后用已有文件工具读取实际项目，编写/审核对象、组成层次、真实关系、证据及结构视图，并报告阅读/建模/校验进度与覆盖缺口。已登记但仍为模板或明显漏掉模块的项目需补全；模型语法有效不代表语义完整。CLI不另起模型、不以目录脚本生成“完整知识”，也不创建Git或tracker。运行数据、索引、布局、任务与观测在[本机数据根](storage.md)，不纳入权威模型。

Git项目建议将上述权威文件与相关源码变更一并提交；引用文档和项目内真实技能文件的归属、机器数据排除及提交授权边界见[存储规格](storage.md#1-数据权威与身份)。`task start`/`task prompt`的可复用规则应直接包含这项建议，不能只依赖agent另读文档。

[project-config.schema.json](contracts/project-config.schema.json)中的 skills.root 可省略，省略使用本机全局技能库；存在时为 worktree 相对路径。解析后的项目内技能根从来源扫描排除，策略记入 sourceScanRevision；禁止将 worktree 根或运行档案当技能根。source.excludePatterns 是根锚定的相对 POSIX glob 列表（`*` 匹配单段、`**` 匹配跨段、`?` 匹配单字符；点文件也参与匹配，无 `!`、字符类或大括号扩展），加入固定排除之外；只改变扫描策略，不删除文件。实际模型目录固定为 `.harness/model`，不提供另一份可编辑对象库。

### 持久身份与当前定位

| 字段 | 权威与约束 |
| --- | --- |
| projectId | `.harness/project.json` 的 UUID；随 Git 共享；不同机器注册同一项目仍为同一项目 |
| worktreeId | 本机注册 UUID，绑定规范根路径/Git common-dir；分支名、commit 和模型 revision 都不是此身份 |
| harness_id | 每个对象及关系 metadata 中的持久 UUID，全模型唯一；读写/证据与历史关联以此为准 |
| locator | 对象为当前 LikeC4 qualified id；关系可展示当前源/类型/目标定位。只作当前文本定位，不作稳定引用 |
| modelRevision | 当前权威模型文件、证据和别名的内容指纹；与分支名分开，也与布局缓存版本分开 |
| sourceVersion | head/treeHash/status，区分已提交与未提交内容；status 为所选来源扫描范围内的 Git clean/dirty/unknown，不是语义已同步，不能照搬包含已排除技能/模型文件的全工作区 git status |
| sourceScanRevision | 实际来源扫描 include/exclude 规则指纹；扫描策略改变不能复用旧核验 |

重命名/移动对象或改关系描述、端点时保留同一实体的 harness_id；新增实体生成新的 UUID。相同关系端点/类型也可有多条关系，由各自 UUID 区分，不能靠文本行号或解析器生成 relation ID 充当稳定身份。删除仅从当前模型移除；已存档任务保留旧实体和旧依据，不回写或清空历史。

[aliases.json](contracts/aliases.schema.json)只保存人工确认的“旧对象 qualified id → UUID”映射。重命名时同任务更新别名和所有当前引用；别名不能抢占当前另一个对象的定位，不能出现歧义或将两个 UUID 合并。别名目标需当前存在；删除实体时移除其当前别名，历史任务已经保存自己的定位，不依赖当前别名表。正式 query 输入只用 UUID；别名用于定位迁移和诊断，不使历史任务跟随当前内容。

从原型迁移须先审核旧 stable_id/证据定位，形成显式旧→新 UUID 清单，逐个更新当前模型并校验；本轮不执行此迁移。原型档案保留原 dot ID，不能为新 schema 强制补 UUID。见[存储迁移](storage.md)。

## 2. 元数据、来源与证据

LikeC4 的 kind 为其 DSL 声明的对象/关系类型；其余必需字段放 metadata。正式校验要求如下；单个标量必须只有一个值，禁止重复字段。

| 字段 | 形式和校验 |
| --- | --- |
| kind | DSL 对象/关系种类的非空标识，需在 specification 声明；语义由项目定义，不强制穷举所有源码粒度 |
| harness_id | 小写 UUID；对象、关系共享唯一性空间 |
| brief | 非空、无换行的简述；用于筛选职责/范围，不能把整篇文档复制为简述；没有未经测量的 token 数限制 |
| source | `fact` / `human` / `inference`：有依据的事实、人工维护声明、AI/人工推断；证据 kind 进一步说明来源媒介 |
| status | `verified` / `needs-review` / `unknown`；inference 不能标 verified。verified 至少有一个可解析证据 ID；不等于全项目已核验 |
| evidence | 一个 metadata 字符串，多个 UUID 用单个空格分隔；无依据写 `none` 并保持 needs-review/unknown，不用空字符串冒充已给依据 |
| version | 非空的人工维护知识版本标记（如 `1`）；不填当前 modelRevision 避免自指 hash，不自动代表 commit |

title 使用原生显示标题，description 为局部正文说明（允许为空）；若需要详细长期说明可引用 Git 中的文档，CLI 不默认读取被引用文档全文。kind/brief 描述职责，source/status/evidence 说明依据，不通过字段名字替代事实验证。

下列只是模板形式；schemaVersion 是 JSON 协议字段，不强行写入 LikeC4 DSL：

```likec4
specification {
  element system
  element component
  relationship calls
}
model {
  app = system "Example SDK" {
    metadata {
      harness_id "10000000-0000-4000-8000-000000000001"
      brief "Public boundary and background task execution."
      source "human"
      status "unknown"
      evidence "none"
      version "1"
    }
    worker = component "Worker" {
      metadata {
        harness_id "10000000-0000-4000-8000-000000000002"
        brief "Runs queued work and propagates cancellation."
        source "human"
        status "needs-review"
        evidence "none"
        version "1"
      }
    }
  }
}
views {
  view overview { include * }
}
```

关系使用相同 metadata 要求；包含层级来自 LikeC4 nesting，关系端点来自 DSL 实际引用。不能为五类展示额外制造“来源对象”“技能对象”。模型校验应同时报告 LikeC4 解析/引用错误、UUID 重复、字段/枚举错误、证据缺失及别名歧义，并给源文件/行列。解析失败保留可明确标记的旧图，但不给新任务当前有效上下文，也不发布同步成功。

### 证据文件

[evidence.schema.json](contracts/evidence.schema.json)规定证据数组，ID 为 UUID；每条包含 kind、claim、location、hash、observedAt，可有 range 和 sourceVersion。文件位置相对 worktree；外部文档 URL 只作引用，不在 query 中自动联网读取。

- source-code / document / manual / inference 是依据类型，与实体 source 的断言属性分开。引用相同文件可支持多条 claim，不复制权威对象或源码。
- 本地 hash 是**完整文件字节** SHA-256；range 是 1 基闭区间，必须 startLine ≤ endLine。URL、尚未核验或没有文件内容时 hash/observedAt 为 null，保留真实未知状态。
- 证据 ID 必须唯一且引用可解析；路径需留在目标 worktree 内。missing/changed/unreadable 分别报告，hash 相同仅证明所核文件字节一致，不自动证明 claim 语义成立。
- 历史归档复制当时引用、版本、核验状态和实际已返回内容；默认不复制全项目源码。当前源码预览必须明确“当前”，不冒充当时片段。

Git项目对本地 `document` 证据批量查询当前索引及原生ignore规则：未跟踪、被忽略或无法核查分别给出 `EVIDENCE_UNTRACKED`、`EVIDENCE_IGNORED`、`EVIDENCE_GIT_UNKNOWN` 警告，诊断附 `file/evidenceId`。已跟踪文件不因ignore规则报警，URL不访问；非Git模型夹具不冒充Git检查。检查只读、不暂存、不改ignore或来源策略，不要求先提交才能组织上下文或核验健康证据。引用文件内容的 changed/missing/unreadable 与Git归属分开处理，见[同步规格](observation-sync.md#5-同步证明与阶段结束)。

### 项目文档生命周期

长期规格、任务Markdown、决策、研究与交接沿用项目既有权威和目录。新材料先判断现有实体是否足以承载，再按需维护简述/说明、关系和证据；不逐文档强建对象、不复制文档正文成为另一套权威。修改需阅读语义影响并核查证据主张/版本；移动保留同一实体/主张的UUID、修复本地路径及文档入链，只有对象locator变化才维护对象别名。删除或替代时清理当前说明/关系/证据/别名中的失效引用；任务/快照/历史技能字节不回写。无语义变化保留核验范围，不制造模型变动或仅刷新hash冒充理解。

留存和Git归属按用途决定：项目长期任务文档可随模型提交，本机task journal/快照仍留在机器数据根；`.scratch`、`handoff`名称不自动决定其寿命。外部URL保存引用，正文按需显式读取，CLI不自动联网或复制。运行时入口指导当前agent完成维护，普通方法在实际产出文档处提示衔接；CLI的目录刷新不自动建立文档关联。

## 3. 渐进披露和精确范围

`task start/prompt` 提供顶层简述、任务 binding、Skill Hub 规则和实际技能轻目录。当前 agent 利用简述一次筛选多目标；无需为每个父节点顺序调用，也无需生成一条先验执行路径。Web 展开只改视图，不替 agent 发读请求，不增加任务批次。

| 请求字段 | 输出与限制 |
| --- | --- |
| expand: UUID[] | 只返回每个对象的**直接子对象**简述，含稳定 ID/当前 locator/title/kind/parentId/children（直接子对象数）；不返回全子树/正文。关系没有层级，expand 关系报 NOT_EXPANDABLE |
| read: UUID[] | 可跨层直达对象或关系，返回精确实体正文、祖先定位、直接关系边界、证据引用与版本；不递归取子树/其他端点正文/源码 |
| known: {UUID:hash} | 只对同任务已保留的完全相同正文返回 unchanged；否则正常返回正文，不采信未经证明的客户端缓存声明 |

[query.schema.json](contracts/query.schema.json)允许 expand/read 混用，至少一个非空。同 UUID 同时 expand/read 合法，表示两种不同输出；同一数组内重复无效。顺序不构成因果：独立目标可并发生产结果，响应数组按输入顺序稳定输出，批次合并按持久提交顺序。

[selection.schema.json](contracts/selection.schema.json)包含同一 context 结构和 skills，显式空集合表示无需额外资源。context 和技能由同一 agent 一次联合提交；CLI 不按关键词冒充选择，不自动增选 related。后续 query 仅补上下文，不更改已保存技能方案。

正文输出是 `contextBody`：entity 保存该实体当前权威声明；对象的 ancestors 只有定位简述，relationships 为其直接入/出关系，scope 为 boundary-reference；读取关系自身时 ancestors/relationships 为空，sourceId/targetId 仅作端点引用。顶层 evidenceIds 为实体与其返回关系所引依据的去重集合，packet.evidence 只带该集合的依据记录。正文 scope 为 exact-entity；输出包只累积实际返回或同任务已保留的正文，祖先/相邻对象不计作已读正文。目录显示总数不等于命中/读取数。

对象、关系、来源、证据、版本五类是以上数据的**五个投影**，命中可交叉，不能把五类计数相加为独立文档量。Skill Hub 是另一路文件资源，按真实 group→skill 名称→文件引用渐进显示，不写入五类/C4。折叠只聚合已选/已返回量，不能把整类标成全部已读。

技能正文由 [file-read.schema.json](contracts/file-read.schema.json)按所选 skillId 和其内部相对路径批量取，expectedHash 必须来自该方案的文件引用；文件 utf8/base64 编码、原字节数及 hash 一起返回。不读取未选技能，不自动执行 Bash/脚本或安装宿主命令；后续标准 agent 的授权和行为不由“选择成功”替代。

默认分发方法应在单独选择时完整可用：移除跨技能的Markdown链接、YAML related清单和指向库根维护说明的链接；少量必要行为直接写在正文，大块参考作为本方法目录内真实附件保留。逐方法捕获后核对本地链接都能从其文件清单解析，附件仍按需读取。此要求针对默认内容，不移除用户自有技能的related能力；候选仍不自动选择、归档或执行。清理当前文件不修改旧方案及已归档字节。

## 4. 指纹、失效和快照

文件 hash 固定为 SHA-256 原字节，小写 64 位十六进制。所有**结构**指纹只有一个 core canonicalJson 实现：按 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785)生成 UTF-8，再 hash `JCS({schemaVersion:1,kind,content})`。禁止重复键、无效 Unicode 和非有限数；字符串不做 Unicode 正规化。快照/指纹是派生或历史观测，不成为编辑权威。

| 指纹 | content 组成及失效 |
| --- | --- |
| modelRevision | `.harness/model` 内全部 `.c4/.likec4`、evidence.json、aliases.json 的 `{path,hash}` manifest，path 相对 `.harness`、按 Unicode 码元排序。新增/移除/字节修改都失效；无效模型不发布有效 revision |
| catalogRevision | 依相对路径排序的实际技能与附件 `{path,hash}` manifest；关联/简述都从相同字节解析。技能文件组 contentHash 用该组内部同形 manifest。不含机器绝对根路径 |
| sourceVersion.treeHash | 按 sourceScanRevision 规则选定的来源路径/字节/删除状态 manifest，含 tracked 变更与非忽略 untracked；精确字段见[存储](storage.md)；无法完整扫描时为 null/status unknown |
| contextBody.contentHash | 正文对象去除 contentHash 字段后的完整结构，kind=`context-body`；模型/依据版本变化均改变结果，不把缓存误当当前 |
| 快照/布局 | 快照按内容寻址，布局缓存 key 另加引擎/布局版本；自动布局变化不改权威模型身份 |

task 绑定来源扫描策略，源码发生变化立即 pending，阶段核验使用 sourceEpoch + 预期 sourceVersion/modelRevision 做 CAS。读任务快照与核验源码语义不同；模型/来源在新请求前变化会拒绝追加并要求新任务，旧包继续可只读查看。运行事件只表示实际采集/返回事实，不证明模型接收、理解或执行。

## 5. 验收要点

- 空模板、多个 `.c4` 文件与命名视图可通过 LikeC4 和字段校验；缺 brief/source/evidence/version、重复 UUID、未声明 kind、断裂端点/证据、无依据 verified 和 inference+verified 明确失败。
- 重命名/移动仍保留 UUID；显式别名校验；删除后旧任务保持当时内容；多个同端点关系不因解析器 ID 改变混淆。
- 同批多目录/正文、跨层直达、精确范围、known 首次不能省略、同任务复用、部分成功、版本竞态、重复选择和幂等重试均有可验证场景。
- Windows/macOS/Linux 相对路径使用 `/` 交换；真实文件解析后再检查边界。拒绝 `..`、绝对路径、盘符、反斜杠和越界链接，不跨 worktree 取内容。
- 直接文件工具仍可编辑；模型变化只更新派生结果，不自动改源码；无语义影响时允许提交 no-semantic-change 声明，须说明已核验范围。
- 旧原型与正式模型分别标记，既有 MGRP 示例和原始工作区本轮不迁移、不改义；程序契约校验不代表正式 CLI 或完整 A01–A10 已验收。
