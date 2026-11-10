# HarnessL3 CLI 使用

正式首版实现与平台验证进度见仓库的[实施状态](implementation/STATUS.md)。需要Node.js 24.12.0或更新的24.x版本，以及Git。CLI使用现有agent，不启动模型，不安装Hooks，也不执行所选技能。

## 安装与初始化

从 GitHub 安装或更新时，执行[安装指南](../INSTALL.md)中的脚本。在源码仓库开发时，可执行`npm ci`、`npm run build`，通过`node bin/harnessl3.mjs --help`查看命令。

从GitHub安装/更新及复制宿主skill见根目录[安装指南](../INSTALL.md)。包内另有`agent-skills/harnessl3/SKILL.md`：用于Codex/Claude Code运行时调用本CLI，与下文Skill Hub的21项方法分开。安装指南在程序安装后显式运行`node <安装包绝对路径>/scripts/install-agent-skills.mjs`，将整个skill目录（含安装更新、项目初始化、运行细节、subagent接入四份按需参考MD）复制到Codex的`~/.agents/skills/harnessl3`和Claude Code的`~/.claude/skills/harnessl3`（支持自定义目录）；不装Hooks，不启动宿主。主入口及四份参考使用英文；先按本轮操作路由技能并独立复用项目上下文，按所需请求处理缺失安装和项目初始化/登记，再执行请求/处理返回。已有接入事实与授权复用，归档恢复不要求当前工程重初始化；参考正文不预读。新会话可分别用`$harnessl3`与`/harnessl3`调用。

安装后所有任务默认先尝试L3组织上下文并筛选技能，问答/研究/规划/实现/审查等哪怕1%可能相关亦触发。每轮按当前操作重判技能并读取所选正文，不能因项目正文已持有而跳过。同技能/合适版本沿用原选择并task read；从to-tickets转implement等技能集合变化或需要新版本时，新建阶段任务，一次选择技能及缺失上下文，随后读取技能正文。已有项目内容在对话中复用，可空选上下文；新任务不继承旧packet，不跨任务填known。无适用技能保持明确空选，不发空文件读取。材料丢失才handoff恢复，缺新内容才差量获取。同task再次读取不重复卡片，新task按既有规则展示一次；计划、技能切换和回复结束不自动关闭未完成任务。父交接保留范围/选择并逐轮读取必要技能，不能重选或关闭父任务；独立范围自行建档。入口恢复不递归，缺有效已有worktree或工具能力时真实报告并继续独立工作。

首次发现当前Git工作区未登记，`TARGET_REQUIRED`及`error.details.onboarding`表示需要接入确认。agent应使用通用询问窗口展示路径和初始化影响；窗口不可用则在对话中询问。同意后先创建缺失配置/登记，再由当前大模型读取项目、直接编写LikeC4对象/关系/证据与结构视图，报告阅读、建模和校验进度；完成覆盖核对后继续原任务。只有拒绝或取消才普通执行，本任务内不重问。已有授权复用，无回复不算同意。CLI的`nextAction:ask-user`与询问内容是给当前agent的指引，不自动初始化，也不在JSON进程内提问；不能因非零退出码直接跳过询问。

本次上下文通过select/query/handoff实际返回且所需技能正文读取后，agent用`web open --no-open --task <task-id> --json`取得链接，在进度消息中显示一次“查看HarnessL3的输出”卡片，再继续用户工作；格式见[运行时skill](../agent-skills/harnessl3/SKILL.md)。卡片使用加粗标题、空白引用行和箭头链接，不包代码围栏；网址只用于链接目标，不另附裸地址、使用/选择说明或常规到期文案。卡片不表示用户工作完成，空选择同样处理，最终答复不重复。Web不可用时仍可继续CLI。

接口发现从`harnessl3 --help`开始；`harnessl3 task --help`列该组命令，`harnessl3 task select --help`给出具体用法、必需/可选参数、请求Schema/示例路径及返回含义。路径指向当前安装包，可用现有文件工具按需读取；嵌套字段由Schema及本地引用定义。帮助/版本仍为静态文本，即使带`--json`也不启动服务或返回业务封套。业务命令只返回当次实际数据，不重复附带完整接口手册。

在一个已经存在的Git工作区执行：

```text
harnessl3 init --name "项目名称" --json
harnessl3 model validate --json
harnessl3 web open
```

init只创建缺失的`.harness/project.json`、`.harness/model/*.c4`、证据和别名文件，以及首次全局技能库；不会执行Git init、切换分支或创建worktree。返回的`initialization.stage:scaffold-ready`表示基础接入就绪，`semanticStatus:not-assessed`表示CLI尚未评估语义；同时给出实际模型数量和当前agent的建模/审核动作。当前大模型随后直接阅读来源并维护模型，不另起模型或用生成脚本猜业务语义。已登记但仍是占位模型时也需要补全结构；已有有效内容保留。

另一个已有worktree执行init或worktree register即可。同一Git common-dir下保持项目UUID相同，各工作区有独立UUID和本机历史。项目身份冲突会拒绝，不能复制其它仓库的projectId冒充同一项目。

## 随源码提交项目上下文

Git项目建议将以下文件与相关源码变更一并提交，便于其他成员和机器取得同一份项目知识：

| 文件 | 内容 |
| --- | --- |
| `.harness/model/`内的`.c4`、`.likec4` | 对象、关系、specification及views，保留稳定UUID |
| `.harness/project.json` | 项目身份及可移植配置 |
| `.harness/evidence.json`、`.harness/aliases.json` | 证据引用与核验指纹、显式身份迁移 |
| 引用的项目文档、决策记录 | 模型依赖的长期说明 |
| 仓库内真实文件形式的项目技能、附件与许可证 | 项目自行维护的共享方法 |

本机数据根、任务journal/历史/快照、归档技能、SQLite/缓存/布局、日志、机器路径配置及访问凭证不纳入源码仓库；保留原数据。不要为提交复制全局技能库，或跟随symlink/junction收录外部实体。按项目规则检查diff和`.gitignore`，Git暂存、commit及push仍遵守已有授权。

项目自己的任务Markdown、规格、决策、研究和长期交接可以是需要提交的项目材料；CLI自身的task记录和快照留在本机。临时草稿和实验输出按用途判断，`.scratch`或`handoff`名字不决定是否提交。被当前C4引用的本地长期文档应与模型、证据和相关源码共同审阅，准备提交时核对这些文件是否齐全。

## 留存或更新项目文档

沿用项目已有文档位置。agent新增材料时判断应关联哪个现有实体；修改后核对简述、关系和证据主张；移动时保留身份、修复路径及入链；删除或被替代时清理当前失效引用并保留历史。文档正文仍由agent按需显式读取，不因建立引用就视为已读。纯文档任务同样需要完成本次范围的上下文核查。

使用`model validate`或`sync status`查看当前状态：

| 提示 | 处理 |
| --- | --- |
| 证据已变更、缺失或不可读 | 阅读并核对变化，修复当前关联/路径，实际核查后更新依据，再核验对应范围 |
| 文档未被Git跟踪 | 准备提交时将长期文档与相关模型一并审阅；工作中可以保留草稿 |
| 文档被Git忽略 | 核对其留存用途和ignore规则，按项目约定决定是否纳入；提示不会自动改动Git |
| Git归属无法核查 | 检查Git及仓库状态后重试，不将未知解释为已跟踪 |

显式引用的本地文件即使被忽略或排除，发生变化仍会待核验；来源扫描策略保持原样。存在证据异常时，相关范围不能标为已核验，无关局部范围可保存；未解决部分继续显示待核验。修复当前文档不会改写以前任务的引用或快照。

## agent的一次任务

先组织并取得本次实际上下文与所需技能，取得链接并显示输出卡片后继续工作：

```text
harnessl3 task start --title "本次任务目的" --json
harnessl3 task select [<task-id>] --file <selection.json> --json
harnessl3 task handoff <task-id> --json
harnessl3 task read <task-id> --file <files.json> --json
harnessl3 web open --no-open --task <task-id> --json
```

task start返回本次绑定、顶层简述、实际技能轻目录和内置Skill Hub路由提示。agent一次选出所需的多个expand/read目标及技能集合；可以跨层直接请求稳定UUID。expand只返回直接子层简述，read只返回精确对象/关系正文与边界引用。祖先、端点或文件引用出现，不表示它们的正文已被读取。

路由提示包含筛选规则和上述Git提交范围建议，指向响应中的结构化taskId/binding/directory/catalog，不把这些数据嵌入提示文本。旧幂等回执/历史仍保留当时原文；规则更新不改任务目的、上下文或技能档案。

selection.json使用start返回的原样binding，填入新的UUID requestId。结构见[selection Schema](spec/contracts/selection.schema.json)及[示例](spec/contracts/examples/selection.json)。技能使用实际catalog ID并说明理由；关联方法不会自动加入，空技能集合也有效。一个task只保存一次联合技能选择。任务ID可作命令位置参数传入，也可写入selection.json的可选`taskId`字段后省略位置参数；两者都不能缺省。

首次读取通常将`context.known`填为`{}`；后续query的`known`也可为空。非空时，键是实体UUID，值是同任务已返回并仍保留的精确正文`contentHash`（64位小写十六进制SHA-256）。它不是“已经了解”的文字说明，也不使用技能、文件或来源哈希。从另一任务复制哈希不能跳过本任务首次正文读取；只需选择技能、`read:[]`时无需填入缓存条目。具体约束也可从`task select/context query --help`发现。

handoff返回累计实际上下文和版本化技能文件引用。文件正文/附件随后以task read和expectedHash按需读取，见[file-read Schema](spec/contracts/file-read.schema.json)。选择与读取技能都不表示已执行。独立的后续上下文可用context query批量请求，见[query Schema](spec/contracts/query.schema.json)。

请求JSON优先使用明确以UTF-8写入的文件；文件输入支持单个UTF-8 BOM。也可使用`--file -`从保证UTF-8字节的stdin传入。Windows PowerShell的默认原生管道可能把中文替换成`?`，因此含中文的请求应先写入UTF-8文件，再传`--file <实际路径>`；已丢失的文字无法靠重新解码恢复。将请求文件放在工作区之外，避免新建未跟踪请求文件改变来源指纹。CLI不会自动把请求文件加入源码排除。

相同requestId及相同语义请求重试会重放已提交回执；不同内容复用同一个ID会冲突。发生取消时，已提交结果仍保留，不要从客户端未收到响应推断未提交。JSON输出只有一个封套；成功0、参数错误2、冲突3、部分成功4、取消130，其它失败1。

## 可靠读取JSON结果

先保存CLI退出码，分别保存stdout与stderr，再解析完整stdout。只有`ok:true`才读取`data`；`ok:false`应保留完整错误封套及`error.code/details`，不能继续索引不存在的`data`。`SCHEMA_INVALID`的`details.schemaFile/example`指向当前安装包，`diagnostics`提供字段JSON Pointer、约束和适用的修正提示。不要截断诊断，也不要把stderr用`2>&1`混入JSON。Bash中管道末端的`head`或解析器成功不代表CLI成功；`pipefail`也不能代替保存CLI自身退出码。

下面的Node读取示例可保存为工作区外的`read-result.mjs`，参数依次是已保存的CLI退出码和stdout文件路径。它在失败时保留原错误，在部分成功时保留返回数据及退出码4：

```javascript
import { readFileSync } from 'node:fs';
const cliCode = Number(process.argv[2]);
const raw = readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, '');
let response;
try { response = JSON.parse(raw); }
catch {
  process.stderr.write('Invalid CLI JSON; preserve the response and check the original requestId before retrying.\n' + raw + '\n');
  process.exit(cliCode || 1);
}
if (!response || typeof response.ok !== 'boolean' ||
    (response.ok && !Object.hasOwn(response, 'data')) ||
    (!response.ok && !Object.hasOwn(response, 'error'))) {
  process.stderr.write('Invalid CLI envelope\n' + raw + '\n');
  process.exit(cliCode || 1);
}
if (!response.ok) {
  process.stderr.write(JSON.stringify(response) + '\n');
  process.exit(cliCode || 1);
}
process.stdout.write(JSON.stringify(response.data) + '\n');
process.exitCode = cliCode;
```

将下面的任务ID、输入文件和输出路径替换为实际值，输出及读取器文件放在worktree之外。Bash保存方式如下，stderr另存诊断文件：

```bash
cli_code=0
harnessl3 task select "$task_id" --file "$request_file" --json >"$response_file" 2>"$diagnostic_file" || cli_code=$?
node "$reader_file" "$cli_code" "$response_file"
```

PowerShell保存方式如下，显式写出UTF-8响应，避免默认重定向编码的差异：

```powershell
$responseText = & harnessl3 task select $taskId --file $requestFile --json 2> $diagnosticFile
$cliCode = $LASTEXITCODE
[System.IO.File]::WriteAllText($responseFile, ($responseText -join "`n"), [System.Text.UTF8Encoding]::new($false))
node $readerFile $cliCode $responseFile
```

失败按错误字段修正请求；响应缺失、损坏或取消则先核对原requestId回执，不由解析失败推断写入未执行。

## 更新上下文与关闭阶段

### 编写与修复模型

先读取 `harnessl3 model validate --help` 和初始化生成的模型。模型仍由当前 agent 通过文件工具维护，下面是可直接校验的最小对象及关系示例：

```likec4
specification {
  element system
  element component
  relationship calls
}
model {
  app = system "Application" {
    metadata {
      harness_id "10000000-0000-4000-8000-000000000001"
      brief "Application boundary"
      source "human"
      status "needs-review"
      evidence "none"
      version "1"
    }
  }
  worker = component "Worker" {
    metadata {
      harness_id "10000000-0000-4000-8000-000000000002"
      brief "Runs work"
      source "human"
      status "needs-review"
      evidence "none"
      version "1"
    }
  }
  app -[calls]-> worker "Dispatch" {
    metadata {
      harness_id "20000000-0000-4000-8000-000000000001"
      brief "Dispatches work"
      source "human"
      status "needs-review"
      evidence "none"
      version "1"
    }
  }
}
views { view overview { include * } }
```

示例 UUID 只用于示例；实际模型保留既有身份，新实体生成独立 UUID。关系必须在 `specification` 声明类型并使用 `-[calls]->` 等相应语法，裸 `->` 不满足 HarnessL3 的类型契约。对象与关系均需完整 metadata。

多条证据使用一个字符串，以**单个空格**分隔唯一 UUID；生成代码使用 `keys.map(k => sources[k]).join(' ')`，不用逗号、数组或重复字段。每个 UUID 必须真实存在于 `.harness/evidence.json`；没有依据使用 `none` 并保持 `needs-review` 或 `unknown`。仅修正格式时直接修复现有文件，不重跑会随机重建全部 UUID 的初始化脚本。文件哈希相同不代表语义核验完成。

### 初始化失败后的处理

- Schema 与示例路径以对应命令 `--help` 返回为准；`Referenced schema` 列出实际本地引用。不要猜测 `project.schema.json`、`task-select.schema.json` 或 `dist/`，安装包不包含开发源码和测试。
- `SOURCE_NESTED_REPOSITORY` 表示入选来源内存在独立 Git 仓库，未递归读取。先检查报错路径的用途；确需排除时，在 `.harness/project.json` 的 `source.excludePatterns` 中显式加入该 worktree 相对路径，再执行原操作。gitlink、特殊文件及冲突索引也保持未知，不自动排除、不删除 `.git`、不改 Git ignore；排除不等于删除，也不覆盖显式证据的校验。
- `SYNC_RACE` 的 `error.details.conflicts` 列出期望和实际冲突字段。即使源码及模型指纹相同，代次变化仍会使旧声明失效。先确认旧回执，重新执行 `sync status`，审核新的待核验范围，再用新 requestId 提交新声明。不能只替换 epoch 或自动重发旧 proof；旧 requestId 继续重放原结果。

PowerShell 在同一调用作用域内先检查退出码及封套，再访问 `data`；下面展示保存结果后的保护步骤，`$responseText` 与 `$cliCode` 来自前面的调用示例：

```powershell
$response = ($responseText -join "`n") | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $response -or $response.ok -ne $true) {
    throw ($responseText -join "`n")
}
if ($cliCode -ne 0) {
    # Partial results remain available in the saved response; handle them explicitly.
    throw "CLI exit $cliCode; inspect the saved response before continuing."
}
$entry = $response.data
```

失败封套没有成功 `data`；不能继续对空值调用 `Get-Member`、生成选择或 proof。

agent直接使用现有文件工具编辑LikeC4、证据或源码；界面展开不修改这些文件。源码或扫描范围变化使状态pending，模型合法与源码clean/dirty分别显示。旧任务继续保持旧绑定，若需要变化后的上下文，应新建任务。入选路径需要外部Git clean/process过滤器时，扫描保守返回unknown，不启动用户脚本；可显式排除该范围。

```text
harnessl3 sync status --json
harnessl3 sync verify --file <proof.json> --json
harnessl3 task close <task-id> --json
```

proof使用当前status返回的目标、sourceEpoch、sourceVersion和modelRevision，声明路径/对象范围、updated或no-semantic-change及核查依据，见[proof Schema](spec/contracts/sync-proof.schema.json)。服务机械核对版本、范围、模型和checks，不代替调用方的语义判断。局部证明不清除未覆盖变化；并发新变动会拒绝旧证明。关闭任务可以保留pending或failed；历史与已选技能仍可读。

## 技能与只读观测

画布逐层展示命中节点和祖先路径，其余节点合并为“…”；点击可进入全部节点列表，搜索、筛选或分页浏览。Skill Hub及技能文件夹采用相同处理。列表可打开详情并显式加入正文、目录或技能候选，返回画布后提交批量请求；查看列表本身不产生读取或选择。历史页面使用当时已保存的模型和目录。

只有Skill Hub路由原则内置。普通技能及附件是可编辑文件，当前7类21项方法随包提供。有效根优先级：HARNESS_SKILLS_ROOT绝对路径、项目配置的skills.root相对路径、默认机器技能库。已有库包括空目录都不补写或覆盖；升级不重置用户内容。默认skills入口通过symlink/junction指向同级持久实体，以免并发创建的空目录被覆盖；编辑入口内文件即可，`.skills-library-<UUID>`是活动内容，不能当临时文件删除。

```text
harnessl3 skills list --json
harnessl3 skills refresh --json
harnessl3 agent bind --agent codex --session <session-id> --log-file <absolute-jsonl-path> --task <task-id> --json
harnessl3 agent status --json
harnessl3 agent unbind <binding-id> --json
```

agent取codex或claude-code。只读取显式绑定日志，不自动寻找其它项目会话；task可省略。绑定请求身份使用传入的绝对路径规范化文本，首次新绑定另核查真实文件身份；原requestId重试先重放回执，文件或符号链接目标消失也不影响已提交结果。首批格式为Codex0.162.1、Claude Code2.1.212的已核验子集。动态命令、无法匹配结果、缺口和未验证格式保持unknown/partial；不保存聊天、正文、完整命令或输出，不用当前文件补造历史版本。

## 历史与维护

```text
harnessl3 history list --query "关键词" --limit 20 --offset 0 --json
harnessl3 history show <task-id> --batch <batch-id> --json
harnessl3 migrate prototype --from <absolute-source-directory> --worktree <uuid> --dry-run --json
harnessl3 gc --dry-run --json
```

60天从最后一次实际上下文披露活动计期，无读取用创建时间。浏览、复制、技能读取、日志补采或关闭不续期；恰好60天仍可见，超期退出默认检索，已知ID仍可只读。首版不永久删除历史。

原型迁移默认为dry-run，显式`--apply`复制且保留源；旧ID、日期、分类和原始字节不重写，缺失为unknown。旧任务只读，不能向其中追加新的正式上下文请求。GC默认为dry-run，只能清明确可重建且无活动租约的数据；任务、journal、快照、技能、blob和未知文件保留。

## 目标与本机服务

当前目录必须属于已登记工作区；在其它目录调用时指定`--worktree <uuid>`。显式目标与当前已登记工作区冲突会报错，不使用“最近项目”兜底。project/worktree list可以从任何目录查询。

机器数据根优先级为`--data-dir`绝对路径、HARNESSL3_HOME、平台默认目录：Windows LOCALAPPDATA/HarnessL3，macOS ~/Library/Application Support/HarnessL3，Linux XDG_DATA_HOME/harnessl3或~/.local/share/harnessl3。它与所有登记工作区的目录树必须互不包含。

```text
harnessl3 serve status --json
harnessl3 serve stop --json
```

服务按需启动，只监听本机回环动态端口。默认数据根由同一用户的所有项目/任务共享一份常驻服务，没有空闲退出时限；停止服务、进程退出或关机后结束。显式`--data-dir`可隔离测试或独立实例。serve status返回开始时间、scope:user-data-root及lifetime:until-stopped。

普通命令和停止操作不会因单次健康检查失败被拦截。暂时连接失败会自动重连，服务已退出时自动恢复；仍不可用会返回可重试的BUSY。`serve status`可区分running、stopped、draining、unavailable和conflict，并给出具体原因。若写请求报响应丢失且`details.outcome`为`unknown`，先查看任务或原requestId的结果；需要重试时遵守对应命令的幂等约定，保留原requestId，避免重复写入。

web open默认打开浏览器，--no-open只返回链接且opened:false。网页首次登录码5分钟/一次性，成功登录后的浏览会话12小时，均非后台进程的寿命；返回的service与login字段分别描述它们。同一浏览器的有效会话可重复打开原链接，不延长会话期限。没有有效会话、清除cookie、换浏览器或服务重启后，已用/过期码需要让agent重新取得链接；页面会提示重新登录。常规可视化提示不附有效期文案。无浏览器不影响CLI，打开失败时error.details提供链接。程序不终止未知端口进程，归档损坏也不能通过清理历史修复。
