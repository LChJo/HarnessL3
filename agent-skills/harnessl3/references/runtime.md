# HarnessL3 运行参考（按需读取）

仅在当前 CLI 帮助不足、需要构造复杂请求、处理同步/重试/历史或配置只读观测时读取。本文件提供操作判断；具体参数、字段与约束由**当前安装包**的 CLI 和 JSON Schema 提供。

所有任务均先尝试L3入口；连续同一有效任务可复用，无需上下文/方法时显式空选。未登记时按主skill经通用询问窗口确认接入，拒绝/取消回退普通执行。父交接已覆盖的子任务复用其范围与选择，独立范围单独建档，详细分支见主skill直接链接的子任务参考。没有有效已有worktree/CLI能力时真实报告，安装/入口恢复不递归调用未就绪入口。

## 从 CLI 发现接口

先按目标操作读取帮助，例如：

```text
harnessl3 task select --help
harnessl3 context query --help
harnessl3 task read --help
harnessl3 sync verify --help
```

帮助给出真实用法、必需/可选参数、返回含义、请求与响应 Schema 及示例的绝对路径。用已有文件工具按需读取这些文件及本地 `$ref`，不猜字段，也不将示例 UUID/hash/sourceVersion用于真实项目。只有需要提交某种请求时才读其契约，不预读全部 schema。

旧版本若只返回总览，可用 `npm root -g` 定位其下 `harnessl3/docs/USAGE.md` 和 `harnessl3/docs/spec/contracts/`；自定义安装使用实际包路径。文件契约与 CLI 版本必须一致。

| 操作 | 契约用途 |
| --- | --- |
| `task select` | 一次联合选择上下文与技能；使用入口返回的原样绑定和实际 catalog ID |
| `context query` | 在同一任务中批量展开简述或补充读取，不产生第二次技能选择 |
| `task read` | 按已选归档引用和哈希读取正文/附件；不从当前技能库补文件 |
| `sync verify` | 以当前状态和真实核查范围提交阶段声明 |

JSON 请求优先放在 worktree 外的 UTF-8 临时文件，避免请求文件改变来源指纹。只有明确保证 UTF-8 字节时才经 `--file -` 传入 stdin；Windows PowerShell 的默认原生管道可能以 ASCII 编码，中文在 CLI 收到之前就变成 `?`，即使 JSON 仍合法也无法自动恢复。不要直接把含中文的字符串或 `ConvertTo-Json` 结果经未配置的管道传给 CLI。

使用已有文件工具明确以 UTF-8 写入；PowerShell 中也可将已构造的 `$requestJson` 写入 worktree 外的 `$requestFile`：

```powershell
[System.IO.File]::WriteAllText($requestFile, $requestJson, [System.Text.UTF8Encoding]::new($false))
harnessl3 task select <实际taskId> --file $requestFile --json
```

新请求生成并保存 requestId；不改入口给出的绑定或手工拼版本。入口的筛选提示指导本次联合选择，目录/正文的字段和层级以真实返回为准。若归档已含替代问号或乱码，保留原记录并说明缺口，不凭猜测改写历史。

## 使用结果与后续读取

使用 JSON 模式时先解析单个封套和退出码：失败看 `error.code/details`；成功看 `data` 的实际种类、状态和覆盖范围。部分成功保留已返回项，只处理仍需的缺失项，不把 `ok:true` 等同于全部完成。

`task start` / `task prompt` 返回实际任务与筛选材料；选择后用 `task handoff` 取得累计精确上下文和归档文件引用。需要更多简述或正文时用 `context query` 批量读取，已知 UUID 可跨层直达。expand只返回直接子层简述，read只返回精确正文；祖先、端点和引用出现不代表其正文被读取。

`routingPrompt`仅给可复用的筛选与Git持久化规则，数据直接使用同一响应的结构化taskId、binding、directory和catalog；不要从提示文本解析或补造字段。Git项目按提示将权威模型/配置/证据/别名与相关源码一并版本管理，项目内文档/技能按实际归属纳入，本机运行数据保留在仓库外。提示不代表获得Git提交授权。历史和幂等回执保持当时返回，不能因为新版本提示变化而重写。

`task read` 只读取已选技能档案。读取所需正文后，再以原有工具完成开发、排查或审查；技能关联是候选，不自动选入或执行。只有已经实际读取并保留的正文才可用于已知内容缓存声明，具体格式仍以本次 schema 为准。

实际上下文通过select/query/handoff返回、所需技能正文读取后，用`web open --no-open --task <实际taskId> --json`取得`result.url`，按主skill在进度消息中展示一次Markdown引用卡片，再继续用户工作，链接文字为“查看HarnessL3的输出”。空选择也遵守同一时机；卡片不表示用户工作已完成，不等到最终答复或task close才显示，后续不重复。网址仅作为链接目标，不附裸网址、使用/选择说明或常规到期文案。CLI不改写宿主渲染器或系统提示，引用与简述不冒充正文。

## 文档留存与阶段同步

长期规格、任务Markdown、决策、研究和交接沿用项目现有目录及权威。先判断材料的用途，再决定留存和Git归属；临时草稿、本机task记录及外部URL按各自边界保存，不因`.scratch`或`handoff`名字自动升级为长期项目文档。已知实际L3任务时，交接写明taskId/worktree、版本及相关文档路径；Markdown交接与CLI归档交接各有用途。

| 本次变化 | 当前上下文维护 |
| --- | --- |
| 新增长期材料 | 判断现有实体是否足以承载，按需补简述/说明和证据引用；不逐文档强建对象 |
| 修改材料 | 阅读语义变化，核对受影响的简述、关系、证据主张和版本；实际核查后才更新hash/时间 |
| 移动或改名 | 保留同一实体/主张的稳定ID，修复证据路径及文档入链；仅对象locator迁移才用别名 |
| 删除或被替代 | 更新当前说明、关系和证据引用，移除失效当前别名；保留已有任务/快照，不借当前文件补造历史 |

纯文档阶段同样适用。`model validate`和`sync status`会保留证据changed/missing/unreadable诊断；命中异常的proof范围不能被全passed声明清除，修复后重新核验。无关局部范围可保存，未解决部分仍pending。Git未跟踪/被忽略/无法核查是归属提示，不要求先暂存；准备提交时审阅相关文档、模型、证据与源码的完整diff，现有提交授权继续适用。只修改排版等无语义变化时如实说明范围，不制造知识变更。

直接用文件工具维护 LikeC4、说明和证据。先 `model validate`、`sync status`，再按需使用 `sync verify --help` 指向的 proof 契约。取最新目标、来源代次/版本及模型版本，填实际路径/对象范围、处置结论和检查证据；无语义变化保留真实核验依据，无待核验变化时不制造 proof。

并发新变动使旧声明失效时重新核查，不循环提交旧版本。失败或未解决范围保持 pending/failed，关闭任务时如实说明。局部证明不代表全项目语义同步，`task close` 只结束上下文组织。

## 重试、历史与观测

- 同 requestId、同请求可重放；不同内容不能复用。响应丢失或取消后，先用 `task show` / `handoff` 确认提交情况，不盲目换 ID 重做联合选择。
- 目标冲突先纠正 cwd/显式 worktree。模型或源码变化后需要新任务；仅技能目录变化且尚未选择时，可用 `task prompt` 刷新当前材料。已关闭任务只读，不向其追加新上下文。
- `history show` 的历史批次只恢复当时已记录内容，不以当前文件补缺。浏览、交接和技能读取不延长60天检索窗口；损坏和未采集保持未知。
- 日志绑定先读 `agent bind --help`。只在已授权且已知真实宿主、会话和日志绝对路径时显式绑定，不猜最新会话或自动扫描。文件变化不等于读取，读取不等于理解。
- 默认用户数据根的全部项目/任务共用一个常驻服务，无空闲退出时限，停止/进程退出/关机后结束；显式隔离数据根可独立运行。serve status的scope/lifetime/startedAt与web open的service/login分别描述后台身份与访问凭证，5分钟一次登录码、12小时浏览会话均非进程寿命。入口失效时按实际错误取新链接，不以裸服务地址冒充已认证入口。GC和迁移是单独操作，不作为入口错误的默认修复方法；用户技能、`.skills-library-<UUID>`和历史须保留。
