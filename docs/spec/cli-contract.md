# CLI 与交换协议 v1

v0.46（2026-11-10）：用户授权按可靠性审查充分修复。默认 task start 为 snapshot：捕获合法模型和技能目录，不扫描源码；binding.mode=snapshot、sourceVersion.status=unknown、sourceScanRevision=null，不声称当前源码已核验。显式 --mode verified 与 sync status/verify 保留完整双遍来源检查、严格代次及 CAS；旧无 mode 绑定仍按 verified 解释。请求进度写 stderr，CLI 等待有界且 request status 可找回原回执；超时不撤销服务已接受的工作。技能变化在同一任务以 --stage 追加，不改旧批次；仍可用且版本合适的正文跨轮复用。下列旧版本记录保留，相关当前要求以本版为准。

v0.45（FR12/15）：宿主命令创建失败不属于CLI封套，CLI无法为未启动的进程发起审批。CLI内原生EACCES/EPERM通过`IO_ERROR`、退出码1、`retryable:false`返回，`details`保留`reason:permission-denied`、`systemCode`及系统提供的`path/syscall`，附`hint`；不据此猜测是ACL或沙箱拒绝。服务描述文件/启动锁的读取拒绝保留该诊断，不伪装身份冲突；进程spawn失败保留可用系统诊断。原业务错误和未知写结果不被替换，审批/重试仍须审查执行结果与原requestId。

agent仅在当前宿主工具及策略允许时请求具体命令/路径审批；接入询问不能授予OS权限，CLI不自行提权。无审批能力、拒绝或宿主启动故障时报告实际阻塞并继续独立工作；不要求全面放开、不改宿主ACL/配置、不迁移数据根或删除历史。安装复制的独立JSON结果保留`error`字符串和`results/current`，权限拒绝额外返回相同`code/details`诊断。真实受限宿主验收不能由非受限进程结果替代。

v0.44：命令名称及projectId/worktreeId不变，init及register支持普通目录。工作区登记见[workspace Schema](contracts/workspace.schema.json)：kind缺失兼容旧git，directory的Git common-dir/branch为空。普通目录来源status为unversioned、head为空且treeHash为完整文件清单哈希；unknown仍不能有treeHash。旧任务、回执和Git指纹算法不改写；原地Git转换后旧任务仍为原绑定，获取新内容使用新任务。目录入口提示随项目备份长期上下文；Git入口仍提示相关源码一起版本管理。首次接入仍由原生询问工具取得同意，最近边界或当前目录为实际目标，不自动创建Git仓库。

v0.43：请求命令的静态帮助递归列出本地`$ref`的真实绝对路径（`Referenced schema`），init/model validate补充证据分隔及关系类型语法，完整示例随安装使用说明提供，不要求消费者读取开发源码或测试。`SYNC_RACE`继续退出3、保留原回执，可附`conflicts`期望/实际字段及`recovery`；恢复是重新status、审核并用新requestId提交新声明，原ID继续重放原结果。调用者失败后不访问成功data；响应及声明Schema不变。

状态：**正式CLI实现契约**，实际代码/验证范围见[实施状态](../implementation/STATUS.md)。本文不是旧`scripts/harness.mjs`原型的使用说明。产品边界见[产品规格](product.md)，模型字段见[模型与读取契约](model-context.md)，持久化和日志见[存储](storage.md)、[观测与同步](observation-sync.md)。对应D01–D15、A01–A10及TC27入口增量。

## 1. 调用约定与目标

- npm 包提供 `harnessl3` 二进制，Node.js + TypeScript 实现，Windows/macOS/Linux 使用相同命令及 JSON；路径差异由平台适配处理。
- CLI 由**当前 agent 主动调用**。它提供确定性的发现、校验、归档和读取，不启动 agent、不请求另一模型、不自动执行技能脚本、不安装 Hooks。
- 全局参数：`--timeout-ms <1..3600000>`、`--quiet-progress`、`--json`、`--project <UUID>`、`--worktree <UUID>`、`--data-dir <absolute-path>`、`--request-id <UUID>`、`--help`、`--version`。全局参数可放在子命令之后。未知参数、重复的单值参数和多余位置参数报 `INVALID_ARGUMENT`。
- 数据根优先级：`--data-dir` > `HARNESSL3_HOME` > [存储规格](storage.md)的系统默认目录。它是本机路径，不写入 Git；必须位于所有已登记 worktree 之外，且不能是 worktree 的祖先目录，登记时也要核查这一边界。
- `--file <path>` 读取 UTF-8 JSON；`--file -` 从UTF-8字节的stdin读至EOF。允许一个文件头BOM，拒绝重复JSON键、非法Unicode、非有限数和未知字段。中文请求优先用明确的UTF-8文件，避免PowerShell默认原生管道在输入前替换成问号；合法ASCII问号不等于可恢复的中文，CLI不猜写文字。不从剪贴板、环境变量或日志猜测请求正文。
- `--json` 的 stdout 只写**一个** UTF-8 JSON 对象和结尾换行；进度、诊断、服务启动提示进 stderr，不输出 ANSI。JSON 模式不提问、不等待交互输入。非 JSON 模式呈现同一结果的文字，退出码完全一致。
- 除 `--help`、`--version` 外，JSON 成功/失败均使用下文封套。`--help` 和 `--version` 是静态文字，不启动服务。

`--help`分为顶层能力总览、命令组（如`task --help`）和具体命令（如`task select --help`）。具体用法、参数名称与必需项复用解析器注册表；帮助同时给出返回含义、当前安装包内响应Schema/使用说明路径，JSON请求命令另给请求Schema与示例的绝对路径及从Schema读取的根必需字段。嵌套格式通过已有文件工具按需读取Schema及本地引用，不在skill维护另一份参数定义。未知帮助主题返回`INVALID_ARGUMENT`/2；`--json --help`仍为静态文字。业务封套与字段不变，不要求每次业务结果重复接口文档。

`--request-id` 与输入 JSON 的 requestId 同时给出时必须完全相等，否则 `INVALID_ARGUMENT`。raw 文件可只省略 requestId：CLI 从显式 flag 或自动 UUID 补齐，再以 schema 验证规范请求；其他必需字段不猜值。调用方需要可靠重试应预生成并保存 requestId；未保存自动 ID 且丢失响应时，不能宣称可“恰好一次”重试，须查询任务/请求记录，不能盲目用新 ID 二次选择。自动生成的 ID 在封套返回，也可在 stderr 诊断提供，不污染 JSON stdout。

`task select/context query --help`还直接展示共享Schema中`known`的说明：通常使用`{}`，非空映射仅引用同任务已返回并保留的精确正文`contentHash`，不得用自由文本或技能/来源哈希替代。帮助与字段错误提示复用此说明，格式校验继续遵守共享UUID/SHA-256契约，不自动填值或放宽校验。

调用方分别保留stdout、stderr和CLI退出码，先检查`ok`再访问`data`，失败保留完整`error.code/details`。`head`或解析器成功不代表CLI成功，不把stderr混入JSON或截断错误。部分成功仍处理已返回数据并保留退出码4，具体示例见[使用说明](../USAGE.md#可靠读取json结果)。

`SCHEMA_INVALID`保留退出码2、`retryable:false`及错误封套，`details`含逻辑`schema`、安装包内绝对`schemaFile`及适用时的`example`。每条`diagnostics`含字段JSON Pointer `path`、`keyword`、`message`、`schemaPath`和约束参数`params`；缺字段、未知字段及非法映射键定位到具体字段，`~`和`/`按JSON Pointer转义。`known`相关错误另附来自共享Schema的`hint`，其它字段不误加该提示。首条字段诊断摘要放入主message，完整诊断保留；不回显请求值、不改历史回执。CLI已在发送RPC前完成请求Schema校验，不为参数错误启动服务或重发写请求。

### 目标解析顺序

1. 验证显式 project/worktree UUID；两者都给出时必须互相归属。只给 worktree 可由登记记录取 project；只给 project 且有多个已登记 worktree 时必须补 worktree，不选最近项。
2. 查找 cwd 最近项目或仓库边界所在的已登记工作区，核验实际根目录、kind及适用的Git common-dir 和 `.harness/project.json` 的 projectId。显式目标与已登记 cwd 不同即 `TARGET_CONFLICT`，不得静默跨项目操作。
3. 带 task ID 的命令可定位该任务归属，但仍必须与显式目标和已登记 cwd 一致。在未登记 cwd 中必须显式提供 worktree（以及需要时的 project），不能仅从 task ID 猜写入目标。
4. 没有任务的目标命令使用显式目标或已登记 cwd；无法唯一解析即 `TARGET_REQUIRED`。不使用全局“最后活动项目/任务”。

无显式目标、cwd处于未登记的已有普通目录或Git worktree时，`TARGET_REQUIRED`的`details.onboarding`提供`state:"initialization-required"|"registration-required"`、实际`worktreeRoot`、`confirmationRequired:true`、`nextAction:"ask-user"`、含路径与影响的`question`、`command`参数数组（`["init"]`或`["worktree","register",root]`）、`fallback:"continue-without-l3"`及`fallbackWhen:["declined","cancelled"]`。这是待接入确认，不是CLI不可用；仅提供指引，不自动写入工作区/登记/任务。agent优先处理此分支，实际调用当前宿主/模式可用且允许的原生询问工具，按用户语言一次展示一个问题及真实路径/影响；异步调用返回或预选选项不是同意；同意后在该根目录执行对应命令并校验，拒绝/取消才本任务普通执行且不重问，未回复不能直接采用回退；已有授权复用。旧CLI只有原onboarding字段时仍先询问。数据根冲突、显式目标不全或其它目标冲突不产生首次接入指引；不能借该指引切换数据根或初始化另一个项目。CLI的JSON模式继续非交互。

`project list`、`serve start/status/stop` 等全局命令无 worktree 时返回 `target:null`；worktree list 的 project 参数仅作过滤，不要求选择该项目的单一 worktree。项目登记结果可有 projectId 而无 worktree，仍放在 data 内，不构造虚假的 worktree。登记同一实际路径幂等；复制的项目标识、路径重定位和已丢失 worktree 按[架构](architecture.md)规则处理，不能仅以分支名识别。

取消登记的本机记录保留 inactive 身份。显式指定原 worktree UUID 时，`history list/show`、`task show/handoff/read` 可只读访问其档案，免 live 根目录存在/HEAD 检查，但仍核对注册归属、显式目标/cwd 冲突及档案完整性；select/query/prompt/sync 等活动操作拒绝。当前源码不可访问时如实显示不可用，不把档案读取变成当前源码已核验。

### 请求进度、等待和结果找回

默认CLI总等待预算120000ms，--timeout-ms可设1–3600000ms；这是内部等待策略，不是性能SLA。stderr在分派前给requestId及阶段，长请求查询认证的/requests/<id>取得恢复、模型、来源扫描、排队等进度；--quiet-progress只关闭进度，不改变stdout单封套。REQUEST_TIMEOUT/1与CANCELLED/130保留原ID及outcome/nextAction；等待结束不取消已接受的服务工作。安装校验将剩余总预算传给CLI，不再受另一层较短默认值截断。

`request status <request-id> [--task <task-id>]`只在解析出的目标内查询running/completed及原receipt；同ID跨历史scope歧义时要求--task。重启后从原journal/引用重核持久回执，不重发原操作；没有可证实记录返回unknown，不能据此宣称未执行。未归档管理结果仅有有界暂存，丢失后保持unknown。进程内相同ID/相同意图的在途请求共享结果，内容冲突拒绝；暂存上限128完成请求/4MiB，最多32在途，预算均非SLA。

[selection-input Schema](contracts/selection-input.schema.json)与[query-input Schema](contracts/query-input.schema.json)描述可省略的任务自有字段；规范化后的原Schema继续严格检查。默认known始终{}，不替调用者编造缓存声明；同requestId使用原提交意图回放，后续阶段不改变推导字段的重试身份。--file与资源快捷参数互斥。

## 2. 首版命令表

尖括号是必填占位符；下表没有列出的破坏性能力不属于首版。所有已有 worktree 操作均只登记/取消登记，不创建、切换或删除 Git worktree/分支。标记“本机”的操作只改变本机状态。

| 命令与参数 | 行为、默认值及主要结果 |
| --- | --- |
| `init [--name <name>]` | 在已有普通目录或 Git worktree 内运行；名称默认根目录名。新建 `.harness/project.json`、`model/`、`evidence.json`、`aliases.json` 最小模板，校验后登记当前项目/worktree。已有配置只校验并幂等登记，不覆盖文件、不 `git init`、不改 AGENTS/agent 配置。首次全局技能库播种见第 5 节 |
| `project register <path>` | 校验已有 `.harness/project.json` 和 Git 项目后本机登记；不隐式创建模型。返回 project 记录 |
| `project list` / `project show <project-id>` | 返回已登记项目；show 不要求已有活动任务 |
| `project unregister <project-id>` | 取消本机项目与其 worktree 登记、停用相应观测绑定；保留工作目录、用户技能和所有档案，返回取消的 ID；不永久清理 |
| `worktree register <path>` | 只登记已有工作区，核对 projectId/common-dir，返回本机 worktree UUID |
| `worktree list [--project <id>]` / `worktree show <worktree-id>` | list 无 project 列出本机登记，带 project 过滤；返回根目录、Git 状态和可用性 |
| `worktree unregister <worktree-id>` | 取消本机登记/观测绑定；保留目录和历史，不删除分支 |
| `task start --title <purpose> [--mode snapshot\|verified] [--session <id>]` | 默认snapshot只捕获合法模型和技能目录；来源unknown/策略null。verified显式完整核验，旧无mode任务仍为verified |
| `task prompt <task-id>` | 尚未选择时返回当前筛选材料；实际目录变化时重建 catalogRevision。模型/来源已变化需新任务。已选择时拒绝重新路由，提示查看 handoff |
| `task select [<task-id>] [--file <json>] [--read <UUID,...>] [--expand <UUID,...>] [--skill <ID,...> --reason <text>] [--stage]` | 任务绑定和空集合可省略，由CLI从原任务解析；显式绑定仍检查。--stage追加技能阶段，不改旧批次；不带该标志的重复选择仍拒绝 |
| `context query <task-id> --file <query.json>` | 同批展开多个目录/读取多个正文，返回 `context-batch`。允许在联合选择前辅助筛选，或选择后补充上下文，不产生第二次技能选择 |
| `task show <task-id> [--batch <batch-id>]` | 查询完整记录或截至该批的累计组织；只读，不续期 |
| `task list [--limit <n>] [--offset <n>]` | 当前目标 60 天窗口内最近任务，默认 limit 50、offset 0；limit 范围 1–200，返回总数/hasMore |
| `task handoff <task-id> [--batch <batch-id>]` | 返回截至指定批（默认调用时最新已记录批）的精确上下文包与**技能文件引用**；缺失部分标未知，不额外读取正文，不续期 |
| `task read <task-id> [--file <json>] [--skill <ID,...>] [--path <relative-path>] [--batch <UUID>]` | 只读所选归档；--skill默认SKILL.md，省略expectedHash从原批次方案解析，显式哈希仍严格匹配 |
| `task close <task-id>` | 幂等关闭上下文组织，拒绝后续 select/query；保留未解决同步/失败状态。不自动验证模型或宣称任务成功；历史与归档读取继续可用 |
| `history list [--query <text>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--limit <n>] [--offset <n>]` | 当前目标 60 天窗口，默认 20/0，limit 1–200；query 匹配目的/任务 ID/声明会话/模型版本，日期按 UTC 最后活动日闭区间过滤。返回总数及分页 |
| `history show <task-id> [--batch <batch-id>]` | 与 task show 相同只读恢复；已知 ID 可查看超期档案，默认 list 不列超期；损坏显式失败 |
| `skills list` / `skills refresh` | 当前目标的实际轻目录/诊断；refresh 立即重扫并发布目录版本，既有选择不变。不传目标时仅可列全局库（target:null），不应用任何项目配置 |
| `agent bind --agent <codex\|claude-code> --session <id> --log-file <absolute-path> [--task <id>]` | 显式只读绑定现有会话日志。目标必需；不自动选择最新会话，不配置 Hooks；task 可选但有则核对归属。返回 bindingId |
| `agent unbind <binding-id>` / `agent status [--binding <id>]` | 停止本机尾读或查询绑定、游标、解析器版本、覆盖缺口；不删除日志/历史 |
| `sync status` / `sync verify --file <proof.json>` | 查看来源 epoch/指纹/扫描策略与待核验范围；提交阶段核验声明并执行 CAS/模型及引用校验，详见[同步规格](observation-sync.md) |
| `serve start [--port <0..65535>] [--foreground]` / `serve status` / `serve stop` | 同一用户/数据根管理单实例，默认 port=0 由系统分配，实际 URL 由握手返回；可显式指定端口，若占用且非同实例则明确冲突，不接入未知服务。仅绑定回环地址；不同隔离数据根可并行 |
| `web open [--task <id>] [--no-open]` | 自动启动/复用本机服务并取得短时一次性Web登录链接。默认打开浏览器；--no-open仅返回链接供agent输出流展示，opened:false。无显式目标/task且cwd未登记可返回无目标工作台；显式目标/task失败不能静默降级。浏览器打开失败给可复制URL，不伪报已打开 |
| `model validate` | 解析当前 LikeC4 并校验[模型字段/引用](model-context.md)，返回诊断；不格式化、不补字段、不编辑模型 |
| `gc --dry-run` / `gc --apply` | 仅枚举/清理[明确可重建派生数据](storage.md)。两个开关互斥，省略默认 dry-run；不清任务、事件、快照、注册信息、技能或源码 |
| `migrate prototype --from <directory> --worktree <uuid> [--dry-run\|--apply]` | 唯一原型导入入口；默认 dry-run，显式来源与目标，复制不删源，ID 冲突不同内容则拒绝；只读 legacy wrapper，不重写旧 ID 或续期。见[迁移规格](storage.md) |

`task read --batch` 与 files.json 的 throughBatchId 同时存在时必须相等；省略两者表示调用开始时固定的最新已记录批，不在传输过程中跟随 SSE。其他 `--batch` 同样固定累计边界。历史恢复和 Web 浏览不新建检索批次。

`serve start --foreground` 为显式诊断模式，服务就绪后进程长驻直到停止；`--json` 仅在 ready 时输出一个成功封套，此后日志全部 stderr，Ctrl+C 优雅停止且不输出第二个 JSON。未就绪即取消返回 CANCELLED/130；ready 后退出码反映长驻进程结束，不把已输出的 ready 回执改写成服务一直成功运行。

服务描述未发布而活启动锁仍存在时，`serve status`返回`state:unavailable`及`diagnostic.reason:startup-in-progress`，可附锁中的pid/instanceId/startedAt；它们是恢复线索，不是认证成功。`serve start`有界等待原所有者，不再额外spawn；`serve stop`尚无法认证停止时返回BUSY，不能返回stopped。已发布控制端点的健康响应可附`recovery:{state,totalWorktrees,completedWorktrees,failures}`，状态查询保留该诊断；running与后台恢复complete/degraded分开，目标请求仍等待其完整资源。状态/启动诊断仅输出允许的构建字段，不透传描述文件中的未知属性或token。

`--version`保持包版本文字；静态帮助另显示构建源提交，dirty或unknown如实标明。服务管理结果的可选`build`包括packageVersion、sourceCommit/sourceDirty和runtimeHash，来源是服务启动时记录的构建，缺失时为null；普通协议1 RPC不要求此扩展。安装工具核对包内指纹与实际文件、运行服务构建和RPC；有更新前handoff原包时，只读比较packet/skillPlan/binding。未提供原包明确not-requested，失败保留阶段与结果未知，不创建用户任务或自动重发业务请求。使用与回滚步骤以根目录INSTALL为准。

普通命令读取服务描述后直接发送认证RPC，不设独立探活门槛。连接拒绝及服务分派前的401/403/409/503拒绝可在重读定位后有界重连；只有确认未执行业务才自动重发，requestId和请求正文不变。未变化的身份/协议拒绝明确报冲突；暂时不可用耗尽重试返回BUSY且retryable:true。状态查询和启动检查对健康请求做有界重试，PID不是端点可用的前提；serve stop直接请求停止并可跟随更新的定位，不依赖健康检查，也不强杀未知进程。

连接诊断在error.details返回reason、适用时的httpStatus/systemCode及原requestId；RPC额外返回outcome:"not-executed"|"unknown"。响应丢失、损坏或requestId不符时保留unknown，CLI不自动重发；调用方先核对已有回执，再按该操作的幂等契约使用原requestId恢复，不能假设所有管理写操作都支持归档回放。取消仍保留已提交结果。错误诊断不输出本地token或浏览会话凭据。

### 返回种类

`task start` / `task prompt`的`routingPrompt`提供可复用筛选与Git持久化规则并指向本封套的结构化`taskId/binding/directory/catalog`，不内嵌这些数据的副本。Git项目的规则列出应随相关源码提交的`.harness/model/`（`.c4`/`.likec4`、specification与views）、`.harness/project.json`、`.harness/evidence.json`、`.harness/aliases.json`，以及按实际归属纳入的项目文档/技能/附件/许可证；同时说明本机运行历史、归档、派生索引/缓存、机器配置与凭证排除，保留用户数据、不收录外部技能链接及遵守已有提交授权。具体字段/嵌套格式由当前帮助及Schema发现。任务目的仍随任务记录保存；既有幂等/历史回执保留当时原文，不为新规则重写。规则文本更新不改变封套Schema或技能选择语义。

非JSON模式先展示一次路由规则，再展示其余结构化数据，避免同一规则又作为JSON字符串重复打印；JSON模式仍保留原有`routingPrompt`字段与完整封套。

[response.schema.json](contracts/response.schema.json)严格定义核心读取结果。管理命令使用 `data.kind:"command-result"`、`status:"complete"`、`operation`（上述完整命令名）、`result`；result 最小字段如下，未列的扩展诊断不改变语义。

| 操作 | result 必需字段 |
| --- | --- |
| init / project register/show | `project:{id,name}`、`paths:{config}`；init 另有 `worktree`、`createdFiles:[]`、`skillSeed:"created"\|"already-present"` |
| worktree register/show | `worktree:{id,projectId,root,gitCommonDir,branch,available}`，root/common-dir 为本机绝对路径；detached branch 为 null |
| project/worktree list | `items:[]`，元素为对应记录 |
| project/worktree unregister | `unregisteredIds:[]`、`archivesRetained:true` |
| task/history list | `items:[{id,title,binding,createdAt,lastReadAt,retentionBasisAt,expiresAt,closedAt,contextCount,skillCount,completeness,format}]`、`total,limit,offset,hasMore,retentionDays:60`；旧数据缺字段为 null |
| task/history show | `task:{id,title,binding,createdAt,lastReadAt,retentionBasisAt,expiresAt,closedAt,declaredSession,batches,packet,skillPlan}`、`throughBatchId`、`completeness`、`expired`；batch 含 requestId/status/request/result/时间，未完成结果为 null |
| task close | `taskId`、`closedAt`、`syncStatus`，重复关闭返回原 closedAt |
| skills list/refresh | `root`、`revision`（无有效目录为 null）、`skills:[]`、`diagnostics:[]`、`checkedAt`、`valid`；非法目录 skills 为空，不拿上次有效目录冒充当前 |
| agent bind/unbind/status | `bindings:[{id,agent,sessionId,logFile,taskId,state,parserVersion,cursor,coverage}]`；unbind 返回停止后的记录 |
| sync status/verify | `state`、`sourceEpoch`、`sourceVersion`、`sourceScanRevision`、`modelRevision`、`pendingPaths:[]`、`proofId`（无则 null）；verify 包含声明与自动检查各自结果 |
| serve start/status/stop | `state:"running"\|"stopped"`、`url`、`instanceId`、`protocolVersion:1`；停止时 url/instanceId 为 null。status另可返回`draining`、`unavailable`或`conflict`，并附`diagnostic:{state,reason?,httpStatus?,systemCode?}`；表示查询完成，不把服务暂时不可达伪报为已停止 |
| web open | `url`、`opened:boolean`；默认成功为true，--no-open为false；URL带一次性浏览会话码，首次登录有效期5分钟。同浏览器有效会话可重复打开原链接，不续期；无有效会话且码过期/已用时重新取链接，不包含CLI连接凭据 |
| model validate | `valid:true`、`modelRevision`、`objectCount`、`relationCount`、`diagnostics:[]`；非法模型用错误封套及 details.diagnostics |
| gc | `mode`、`candidates:[{path,kind,bytes,reason}]`、`totalBytes`、`removed:[]`，dry-run removed 为空 |
| migrate prototype | `mode`、`migrationId`、`source`、`target`、`tasks:[{id,action:"copy"\|"skip"\|"conflict",completeness}]`、`sourcePreserved:true`；dry-run 不写注册/档案 |

该 result 表是 v1 字段契约，JSON Schema 对管理 result 仅检查对象封装，额外语义/字段存在性须由各命令验收测试验证。核心请求和结果不允许未知字段。未来破坏性字段变化须提升 schemaVersion；protocolVersion 是服务握手版本，不等于 npm 版本。

v0.25的管理result增量：init增加`initialization:{stage:"scaffold-ready",semanticStatus:"not-assessed",modelCreated:boolean,nextAction:"model-project"|"review-project-model",model:{objects,relations,views},agentGuidance}`；数量只表示当前可解析模型，不证明完整性。当前agent按实际项目阅读/建模/校验并报告进度，直接用文件工具维护LikeC4和证据。serve结果增加`startedAt`（未运行为null）、`scope:"user-data-root"`及`lifetime:"until-stopped"`；默认全用户项目共享当前用户数据根服务，显式数据根隔离继续有效。web open增加`service:{instanceId,scope:"user-data-root",lifetime:"until-stopped"}`和`login:{oneTime:true,expiresAt,browserSessionTtlMs:43200000}`，expiresAt是一次登录码到期时间，非进程退出时间。JSON stdout仍只返回一个封套，不代agent显示进度或注入宿主提示；当前v0.32由agent在实际上下文和必要技能正文返回后取得链接，在进度消息中展示一次“查看HarnessL3的输出”引用卡片，再继续用户工作。

`model validate`保留本地证据内容和Git归属诊断，文件诊断可附`evidenceId`。`sync status`同样返回成功加载模型时的证据诊断；`sync verify`新增自动检查`referenced-evidence`，命中当前引用changed/missing/unreadable的路径或实体范围返回`SYNC_UNRESOLVED`，无关局部proof仍可保存且全局保持pending。Git未跟踪/被忽略/无法核查为只读建议，不要求先暂存。请求和封套Schema不变，历史/幂等回执保留原文。

`routingPrompt`也包含长期项目文档的增删改移和阶段维护规则：当前agent用普通文件工具维护受影响简述/关系/证据，保留稳定身份和历史；项目任务Markdown与临时草稿、本机task journal分开，不以`.scratch`名字决定Git归属。正文按需显式读取，CLI不自动建立文档关联。

## 3. 版本、批次与错误

### 版本和幂等

- 每个新任务绑定 projectId/worktreeId/modelRevision/catalogRevision/sourceVersion/sourceScanRevision；snapshot显式记录mode与来源unknown/策略null，verified来源指纹包括未提交状态，分支名不充当身份。
- snapshot的select/query从原模型快照取正文，选择仍检查实际技能目录；verified另核对当前模型、完整来源及策略。显式版本不匹配整体拒绝，不部分保存技能，不调用模型自动重选。未选择的prompt可刷新技能目录；需要新模型或verified来源绑定另建任务。
- `context query`不因无关技能变化强制重选；snapshot也不因无关源码变化失效。技能正文始终读取原方案归档，允许当前目录改变或消失。
- 规范请求的 `requestId` 来自文件、显式 flag 或 CLI 生成值。对同一 task（创建请求则为同一目标 worktree），相同 requestId + 相同 JCS 请求重试返回原已归档响应，不增加批次或最后活动时间；相同 ID 不同请求报 `REQUEST_ID_CONFLICT`。并发独立 query 可读取同一不可变快照，批次提交串行合并，不覆盖先提交结果。
- 每阶段只允许一次联合选择；同任务显式--stage追加新方案并保存原批次，普通第二次选择仍拒绝。有效commit与引用完整时同ID回放原结果；没有commit的中断未生效，孤立文件不证明成功。引用损坏报ARCHIVE_CORRUPT，不以当前字节补造；SELECTION_UNKNOWN仅用于真实不确定的旧记录。
- `known` 只允许略去**该任务已归档保留且内容指纹一致**的正文；调用方单方面声称拥有内容不能跳过首次返回。返回 `unchanged` 仍能引用原包。不把 known 用作“不需要检查版本”。
- 目录/正文成功返回才计作已记录读取活动；纯历史、handoff、技能归档读取、幂等重试、Web 展开、状态检查和关闭不续期。恰好 60 天仍在窗口内，超期拒绝新 select/query，档案保留。

### 成败规则

形状/目标/全局版本/技能选择校验在写批次前完成，错误不会生成伪成功批次。通过整体校验后，expand/read/skill-file 各项独立处理；合法结果与单项失败并存为 `ok:true,data.status:"partial"`，保留每项错误并退出 4。纯 query/file-read 全部失败返回 `ok:false`、退出 1，details 含 itemErrors 和 batchId。select 的技能方案已成功持久化时，即使上下文全部单项失败也为 partial；显式空技能/空上下文联合选择合法，准确记录“无需额外资源”。

成功封套：`{schemaVersion:1,requestId,target,replayed,ok:true,data}`；失败封套：`{schemaVersion:1,requestId,target,replayed,ok:false,error:{code,message,retryable,details}}`。首次 replayed 为 false，幂等回放为 true；回放标志不改原归档正文。无法解析或目标冲突时 target 为 null；已确定安全归属后发生错误可保留 target。target 和 data.binding 的 ID 必须一致。错误 message 供人阅读，自动化按 code/退出码判断。

| 退出码 | 错误码或情况 | 调用方行动 |
| --- | --- | --- |
| 0 | complete（历史部分恢复用 completeness 标记，不冒充当前新请求的 partial） | 使用已记录结果，遵守范围 |
| 2 | INVALID_ARGUMENT、INVALID_JSON、SCHEMA_INVALID、UNSUPPORTED_SCHEMA | 修正参数/文件；未知主版本不尝试猜字段 |
| 3 | TARGET_REQUIRED、TARGET_CONFLICT、PROJECT_ID_CONFLICT、WORKTREE_MOVED、VERSION_CONFLICT、SOURCE_CHANGED、CATALOG_CHANGED、REQUEST_ID_CONFLICT、SELECTION_EXISTS、SELECTION_UNKNOWN、TASK_CLOSED、TASK_EXPIRED、SYNC_RACE、SERVICE_CONFLICT、BUSY | 检查目标/原结果；目录刷新或新任务；不可盲目覆盖 |
| 4 | 成功结果含单项错误，data.status 为 partial | 保留成功项，只重试需要的失败目标 |
| 1 | NOT_FOUND、MODEL_INVALID、CATALOG_INVALID、CONTEXT_TARGETS_FAILED、SKILL_FILES_FAILED、ARCHIVE_MISSING、ARCHIVE_CORRUPT、SYNC_UNRESOLVED、IO_ERROR、LOG_UNSUPPORTED、BROWSER_OPEN_FAILED、INTERNAL_ERROR | 根据 details 修复；缺失历史不以当前内容回填 |
| 130 | CANCELLED | 已提交结果仍保留；查询 requestId/batchId，不猜是否成功 |

文件路径穿越、越界符号链接、期望归档 hash 不符、同技能不同理由的重复选择均为参数/完整性错误，不能静默合并。单项错误常用 `ENTITY_NOT_FOUND`、`NOT_EXPANDABLE`、`SKILL_NOT_SELECTED`、`FILE_NOT_ARCHIVED`、`HASH_MISMATCH`。目录非法整体不给当前候选；未确认写入或持续占用不能报保存成功。

## 4. 完整调用样例与可校验材料

下面是正式CLI调用形式；安装和输入文件操作见[使用说明](../USAGE.md)，各平台已运行范围见实施状态：

```text
harnessl3 init --name "Example SDK" --json
harnessl3 task start --title "Find the cancellation state boundary" --json
harnessl3 task select [<task-id>] --file selection.json --json
harnessl3 context query <task-id> --file query.json --json
harnessl3 task handoff <task-id> --json
harnessl3 task read <task-id> --file files.json --json
harnessl3 sync status --json
harnessl3 sync verify --file proof.json --json
harnessl3 task close <task-id> --json
```

所有例子采用虚构项目 UUID/内容，不能拿去指代本机 MGRP 任务。可从入口返回的 binding/ID/hash 填入下列请求；没有读取顺序要求的目标放在同一数组，不为动效拆请求。

- [选择](contracts/examples/selection.json)、[混合批次](contracts/examples/query.json)、[归档文件读取](contracts/examples/file-read.json)、[阶段核验](contracts/examples/sync-proof.json)。
- [成功选择响应](contracts/examples/selection-response.json)、[部分成功](contracts/examples/query-partial-response.json)、[错误](contracts/examples/error-response.json)、[归档文件响应](contracts/examples/file-read-response.json)、[无目标管理响应](contracts/examples/no-target-response.json)。
- [项目配置](contracts/examples/project-config.json)、[证据](contracts/examples/evidence.json)、[重命名映射](contracts/examples/aliases.json)、[旧任务包装](contracts/examples/legacy-response.json)。
- [契约目录说明与校验方式](contracts/README.md)包含对应 schema、正反例和不能由 JSON Schema 判断的语义检查。

## 5. Skill Hub 和迁移兼容

npm另分发文件型运行时接入skill `agent-skills/harnessl3/`，供现有Codex/Claude Code正确调用上述CLI流程。D15约定安装后所有任务默认先经L3，1%可能相关也触发；连续项目上下文可复用，但每轮按当前操作重新判断并task read所选技能正文；同技能/合适版本沿用原选择，技能集合或所需版本变化时使用现有start/select/read建立新阶段任务并仅选择缺失上下文。空选择合法，新task不继承旧packet，不支持在已选择task内重选。`SKILL.md`提供触发/子任务分支、调用时机、返回含义、使用判断和少量入口示例；具体参数以当前CLI帮助/契约为准。安装更新、项目初始化、运行细节及子任务交接另放在`references/`，仅命中条件时读取，不自动预读或注入正文。有父交接的子任务复用普通task/handoff/query/read，不重选或关闭父任务；独立范围自行创建/关闭自己的task。此为agent工作约定，CLI未提供父子专用字段/权限隔离，不自动启动子agent或绑定其日志。

该入口不属于普通方法seed或内置路由原则，与Hub当前21项方法分开。安装指南在安装/更新包后显式调用包内`scripts/install-agent-skills.mjs`，将整个skill及附件复制到Codex的`~/.agents/skills/harnessl3`与Claude Code的用户级skills目录；不使用npm生命周期Hook，不启动agent。相同字节不重写；更新既有主入口或附件先在skills根外按相对路径保存原字节备份，保留其它内容；实际逐文件复制结果与宿主发现/运行验证分开记录。引导恢复不递归，无明确目标或入口能力时真实报告，不伪报调用。默认目录及覆盖方式见[安装指南](../../INSTALL.md)。D13/D14的权威、技能归档和接入边界不变。

内置的只有路由原则。npm携带独立seed文件（当前7类/21方法、附件、MIT与来源）；init仅在`<dataRoot>/skills`根完全不存在时，以[持久实体及独占目录入口](storage.md#2-目录与文件职责)发布完整副本。既有/并发出现的目录即使为空也不合并或覆盖；升级不改用户正文。实际路径优先HARNESS_SKILLS_ROOT本机覆盖、项目skills.root（worktree相对）、全局库。技能根不能等于worktree根、`.git`、`.harness`或运行档案目录；专用skills入口及其解析后的持久实体允许，不能据此把任意dataRoot子目录当库。项目内根固定排除来源扫描并记入sourceScanRevision。入口、实体和用户技能都不是可重建缓存，gc不删。

扫描实际 `<group>/<name>/SKILL.md`，解析 name/description/可选 related，并保留普通附件原字节；name 和目录 ID 分开。目录/正文不可由固定手工名单推导。关联只辅助筛选，不自动选中，不递归加载正文。目录增加/删除/修改只更新当前轻目录和待选择提示，既有任务方案和已归档文件不变。非法当前目录显式诊断并清空候选。

正式请求的 UUID 身份、JSON 封套与原型协议不同，不能直接把原型脚本当实现。显式导入将旧档案包装为 `legacy-archive`（schema 中单列），原始 ID/文件/已记录状态保留，缺 sourceScanRevision、稳定 UUID 等字段保持 null/未知。禁止为满足新 schema 借当前模型补造历史；旧任务只能查看/读已有归档，新的上下文请求须新建正式任务。实现验证使用合成复制夹具，原有85份开发历史未迁移或改写。
