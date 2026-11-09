# 正式首版实施状态

2026-11-07，基准0.21的M1–M4首版本地候选0.1.0已实现并完成下述既有范围验收；功能提交`f8eb2a4`的最终三平台CI全部成功。当前[基准](../PROJECT_BASELINE.md)为0.36，增加安装验收、后台恢复与历史读取优化；0.35的稳定连接、分类诊断和有界恢复及此前技能/文档/输出卡片边界保留。TC27未实跑宿主范围仍待验收。本页记录代码与实际范围，旧三平台结果不覆盖本次增量。

## v0.36 安装与累计历史恢复（2026-11-09）

按用户授权实施安装复盘中的优化，基于`34f3dde`，在独立分支`perf/startup-history-20261109`工作。活启动锁不再被status和stop误报为已停止；start有界等待原所有者，不另起竞争进程。路径隔离预检后发布控制端点，档案/显式订阅在后台恢复，健康诊断单列恢复进度与失败；目标请求仍等待自己的完整验证，关闭等待在途恢复，恢复与GC apply互斥，订阅恢复和取消登记串行。

同一Runtime中的启动恢复、任务资源及普通legacy列表复用已验证Archive；记录按类型/任务派生定位，迭代固定调用边界，头与引用查询不复制无关正文。恢复轮次内共享引用验证，之后读取仍复核原字节，不放宽哈希链、任务契约、损坏区域、幂等或保留期。安装指南保留旧包，构建时记录Git来源/dirty或unknown、依赖锁及实际运行文件指纹；显式验证工具核对实际服务构建/RPC，适用时与更新前UTF-8交接原包比较，不创建用户任务或自动重发未知业务请求。

新增失败回归依次观察到：活锁被报stopped、已有启动所有者直接BUSY、首访同档案三遍恢复、16条提交重复读取共享内容、按已知ID复制无关历史，以及阻塞恢复时控制就绪超时和清理请求等待；修复后通过。状态构建字段还按允许字段投影，扩展既有凭据不泄露测试；安装工具直接入口使用`import.meta.main`，真实中文链接消费者先捕获空输出，再通过。测试使用合成Git/数据根，不在真实开发档案上注入故障。

Windows / Node24.12.0：完整构建通过；`node scripts/v1/test-runner.mjs`共328项，324通过、4项平台能力跳过、零失败。Edge157.0.4341.42在CRLF夹具下的3组既有浏览门禁通过；3个提交到绘制样本P50/P95为675/774ms，仅本轮功能验证样本。真实npm安装消费者通过：142包文件、21方法、两个临时宿主目录各5份运行时文件、入口/Schema/归档/登录/离线资源，以及服务构建、旧交接比较、改动对照包/运行字节后的拒绝；这些不是两宿主实际发现或执行验证。PowerShell指南通过AST语法检查，Bash指南通过`bash -n`；未把未提交源码当作最新GitHub安装实跑。

双worktree完整合成历史共407227038字节，每边702任务、每任务8批次、711提交。已安装基线与候选分别用相同档案测3个新服务进程：控制就绪P50为44.37s→1.50s，启动至首次交接总P50为104.61s→24.77s，进程lifetime峰RSS为3.26GiB→1.30GiB，journal指纹及交接包保持不变。后续请求可能与另一工作区恢复重叠，不能当作无后台竞争的稳态结果；补测与原始方法/限制见[性能记录](PERFORMANCE.md)。运行代码指纹为`cbda17aed1b64a1dda2d322b1fed11757a0bc3633f89131df3320baadfdb9dd4`。

本机证据保存在`.harness-local/validation/startup-history-v036/`，安装包在`.harness-local/artifacts/`。模型/关系/当前证据按实际范围维护，保留无关`web/main.tsx`既有证据警告及其余pending，不宣称全工作区同步。提交准备补齐本轮证据文本的显式LF约束，核对工作区、Git暂存和隔离检出字节，避免跨平台行尾转换造成证据失配。上述本机验证针对未提交的0.1.0候选（sourceDirty:true），当时未替换全局包或重启真实常驻服务，也未新增Linux/macOS原生CI验证；后续提交、推送与三平台门禁以对应Git提交、Actions实际运行及终端summary记录为准，不借用旧结果。

## 主干CI修复：原型模型监听遗漏通知（2026-11-08）

审查`main`提交`bcb39b8`的[GitHub运行42480303563](https://github.com/LChJo/HarnessL3/actions/runs/42480303563)：Windows/Linux构建、程序、浏览和安装全部通过；macOS程序320项中314通过、1失败、5项平台能力跳过，浏览和安装未执行。唯一失败为`tests/prototype.test.mjs`的真实文件监听更新在7秒内未返回新模型；公开注释未能确定macOS底层通知丢失或延迟的具体原因，不能将本次超时直接归因于服务恢复代码。

原型工作台此前仅依赖原生`fs.watch`通知。新增隔离回归保留真实文件、LikeC4解析和缓存落盘，仅抑制原生通知：等长文件内容修改稳定复现旧模型不更新，随后增加每秒模型内容核对后通过。未变化时不重新解析或发布事件，关闭时取消定时核对并等待在途核对结束；原生监听及原7秒门禁保持。当前保留原型的修复与冻结归档分支分开，不扩展正式CLI产品契约或改变基准0.35。

Windows / Node24.12.0：原有6项原型检查先通过；新增遗漏通知回归先实际失败，再与原有检查合计7/7通过。随后完整构建通过，完整程序321项中317通过、4项平台能力跳过、零失败。当前模型有效（21对象/28关系），本次3份证据和15个本地文档链接核对通过；保留无关`core/context.ts`及`web/main.tsx`既有证据警告。RED/GREEN与本轮报告保存在`.harness-local/validation/ci-watch-20261108/`。推送后的完整三平台门禁以对应Actions实际运行及终端summary记录为准，逐平台核对构建、程序、浏览及安装，不以本机结果代替远端验收。关系和正式规格无语义变化，基准保持0.35；本机L3服务不可用时的阶段同步按上述范围人工核查，不宣称全项目同步。

## v0.35 本机服务连接稳定性（2026-11-08）

用户确认本地CLI以稳定连接、自动恢复和数据完整性优先。普通命令读取本地描述后直接认证RPC，移除原先每命令一次健康检查的硬门槛；服务在业务分派前核对可选实例/数据根头和协议，仍兼容协议1旧客户端。健康检查只用于状态/启动诊断，返回running、draining、unavailable或conflict，PID只作恢复线索；超时/连接失败/服务排空不再统一报身份冲突。`serve status`保留具体原因，查询完成不等于服务正在运行；`serve stop`直接请求并跟随定位更新，不再被探活阻断。

连接拒绝或分派前HTTP拒绝才允许有界重连，重读描述并保持原requestId；确认死亡且端点拒绝连接时进入现有启动锁流程，不强杀未知进程或并起第二个写实例。请求发出后响应丢失、损坏或requestId不符保留outcome:unknown，不自动重发；业务幂等仍由各自已有归档/回执契约约束。超时/重试参数为内部默认值，不新增SLA或远程服务能力。

[新增CLI/HTTP回归](../../tests/v1/service-stability.test.mjs)覆盖探活不可用但初始化/RPC正常、慢响应和临时失败、PID独立判断、状态分类与凭据不泄露、端点/停止定位轮转、同requestId准入重试、死亡恢复、分派前身份/数据根/协议拒绝；真实临时档案在服务提交任务后丢弃响应，核对CLI不重复创建任务且原requestId回放同一回执。前三条缺口及停止轮转先分别观察失败，再修复；其余作为恢复与提交一致性保护检查。全部夹具使用独立临时Git/数据根，不使用真实用户档案或技能作测试数据。

Windows / Node24.12.0：完整`npm test`共320项，316通过、4项平台跳过、零失败，包含最终9项新增服务稳定性回归。此前18项相关服务/CLI/Web服务检查通过，停止轮转另先失败后通过；Web构建及完整安装消费者通过，包含独立npm安装入口、21方法、双宿主技能文件、任务/归档往返、登录与2项离线资源。当前LikeC4模型有效；本次CLI/服务/基准/存储与新增回归证据按实际阅读维护，保留无关`core/context.ts`和`web/main.tsx`既有证据警告，未宣称全工作区语义同步。证据保存于`.harness-local/validation/service-stability-v035/`。本轮未运行新的Linux/macOS原生门禁或浏览器交互；未提交/推送、发布或替换本机全局安装，共享常驻服务未重启。

## 主干CI修复：macOS安装包Schema路径（2026-11-08）

检查提交`2ab1298`的[GitHub运行42445211495](https://github.com/LChJo/HarnessL3/actions/runs/42445211495)：Windows/Linux三平台门禁中的各自构建、程序、浏览和安装均通过；macOS构建、311项程序检查（306通过/5平台跳过）及浏览通过，安装消费者进一步在Schema路径断言失败。帮助返回真实的`/private/var/...`路径，夹具预期仍为同一位置的`/var/...`别名；上轮安装器入口修复已生效，不能将这次失败仍描述为空stdout。

首个修订`4ecf09a`的[GitHub运行42446942003](https://github.com/LChJo/HarnessL3/actions/runs/42446942003)中，Linux/macOS全部通过；Windows的构建、311项程序（307通过/4跳过）及浏览通过，安装消费者进一步发现`RUNNER~1`与`runneradmin`短/长目录名差异。只解析预期路径仍不够：Node帮助可能保留合法短目录名，文件系统解析则返回长目录名。本机通过真实8.3短临时目录再次复现了同类失败。

安装消费者现固定通过工作区外临时夹具中的中文目录链接进行npm安装和CLI调用，使三平台都覆盖路径别名。帮助路径必须为绝对路径，帮助与预期两侧都经`realpath`解析后核对，仍要求精确指向该安装包内实际存在且可读取的Schema；不放宽为文件名或路径后缀匹配。既有安装、双宿主技能原字节、任务/归档、登录和离线资源检查保留，清理只限独立临时夹具。本轮仅修改验证脚本及相关当前模型/证据，D05/D06/D09/D14、FR12及TC22/26契约不变。

Windows与WSL2原生Linux / Node24.12.0的完整安装消费者均通过新增中文链接目录场景，Linux安装器既有回归另9/9通过；短目录名补充修复另在Windows真实8.3临时目录和Linux分别完成完整消费者验证。程序/浏览器代码未改变，本轮完整三平台门禁由后续Actions实跑核对。本轮验证输出独立保存在`.harness-local/validation/ci-all-green-20261108/`，包含GitHub运行/任务/检查注释、两种路径别名RED和完整消费者结果；后续提交的三平台结果以对应Actions实际记录和终端summary为准，不以本地通过代替。既有`core/context.ts`及`cli/help.ts`证据警告保留，用户技能和任务历史未改写。

## 主干CI修复：安装器入口与安装包帮助（2026-11-08）

检查`main`提交`391f54b`的[GitHub运行42394263217](https://github.com/LChJo/HarnessL3/actions/runs/42394263217)公开检查注释：三平台程序测试均零失败，最后的`package-smoke`失败。Windows/Linux仍断言旧的`task select <task-id>`帮助，实际契约已允许`task select [<task-id>]`；macOS在解析安装器stdout时得到空内容。本轮落实既定D05/D06/D09/D14、FR12及TC22/26，不改变基准0.34或产品契约。

Windows真实安装消费者先复现帮助断言失败。另用中文/空格的目录链接调用独立安装器，稳定复现进程退出0却没有JSON或安装结果：原入口比较`process.argv[1]`与模块真实路径，链接别名不相等时跳过执行；macOS临时目录也可能经`/var`与`/private/var`表达同一位置。现使用正式最低版本Node24.12.0支持的`import.meta.main`判断直接执行，模块导入不触发安装；帮助断言对齐已有可选任务ID契约。新增回归检查链接入口的JSON、两宿主五文件原字节、重复安装及非法参数失败；不改变目标链接检查、用户文件备份或复制范围。相关新增源码证据固定LF以保持跨平台指纹。

Windows与WSL2原生Linux / Node24.12.0安装器回归各9/9通过；Windows CLI/Web构建及完整`npm test`共311项：307通过、4项平台跳过、零失败。Windows/Linux完整安装消费者均通过，覆盖npm bin、21方法、两宿主技能、任务/归档往返、精确登录链接和2项离线资源；LF规范化后的最终Windows包另复跑通过。此次未重跑完整Linux程序矩阵或浏览器交互，不借用旧结果扩大范围。

证据独立保存在`.harness-local/validation/ci-latest-20261108/`，包括公开Actions检查摘录、两个RED、回归、构建及安装输出；本机历史和用户技能不作测试数据。模型维护既有Agent入口/隔离验证实体及证据，身份和拓扑保留；既有`core/context.ts`与`cli/help.ts`证据哈希不匹配未借本轮刷新。未运行原生macOS或推送后GitHub三平台复跑，未提交/推送、发布或更新本机全局安装。

## 主干CI修复：路径规范化与目录事件（2026-11-08）

检查`main`提交`1f1d011`的[GitHub运行42388180203](https://github.com/LChJo/HarnessL3/actions/runs/42388180203)：三平台构建成功，Windows/macOS在安装器回归的附件状态断言失败，Linux在TC08链接证据修复后仍为pending；浏览和安装步骤因此跳过。本轮落实既定D06/D08、FR09/12和TC07/08/26，不改变v0.34目标或验收契约。

安装器将目标根目录解析为真实路径，原测试用输入路径查找返回文件，遇到链接或系统路径规范化时得到undefined。现按稳定的`relativePath`查找，再核对安装器返回的规范化绝对路径；新增链接技能根场景，继续检查自定义正文原字节备份和其它用户文件保留。安装器行为未改。Windows临时目录链接和新增回归均已先复现同一错误。

Linux原生文件监听会以链接目录名报告目标变动。原实现同时留下`ignored/alias`目录及其引用文件的pending，单文件proof只能清除文件。现将目录通知映射到实际受影响的引用文件，仍推进代次和核对模型；不增加不可由单文件声明清除的目录范围。新增同目录双证据回归，确认核验一份文件后另一份仍pending。Linux原有TC08及新增回归均先失败，修复后Windows/Linux四项针对性检查各4/4通过。

Windows/Node24.12.0完成CLI/Web构建、完整`npm test`共307项：303通过、4项平台跳过、零失败；Edge157的三组浏览检查和真实消费者安装冒烟通过。Linux/WSL2、Node24.12.0完成同样构建及307项测试：304通过、3项平台跳过、零失败；Chromium156的三组浏览检查和真实消费者安装冒烟通过。两项新增测试作为模型依据固定为LF；与Linux副本的换行差异单独核对，统一后四项针对性检查再次通过，核心源码原字节一致。

本轮证据在`.harness-local/validation/ci-main-20261108-824251e8/`，包括已观察GitHub检查注释摘录、RED/GREEN、完整测试及浏览/安装报告；既有默认报告、截图及候选包已先另存。本次模型检查为21对象/28关系、38条依据，维护同步说明而保留身份与拓扑；阶段声明只核验本任务改动，其余既有pending保留。本轮未运行macOS增量或推送后GitHub三平台复跑，未暂存/commit/push、发布或更新本机全局CLI/用户技能；原任务历史不回写。

完整验证结束后，当前worktree另有`core/context.ts`、`core/contract.ts`并发改动，未包含在上述结果中，本任务保留且不改写。首次收尾声明因此返回`SYNC_RACE`，未冒报同步完成；后续按最新版本仅处理本任务范围，证据与未解决状态分别留存。

## 未提交审查修复：引用路径与输出帮助（2026-11-07）

按用户授权修复上轮审查的四项问题，落实既定D08/D15、FR09/12及TC07/08/27，不改变当前v0.34的产品范围。显式引用在`.harness`等目录分流前处理，未被引用的模型/技能/输出保留原规则；观测索引同时记录声明路径及边界检查后的真实目标，目标暂缺时保留最后安全目标用于观测重建。修改和字节回退推进代次，旧proof被拒绝，来源manifest不扩展。核验范围及pending清理统一使用真实路径和平台大小写语义，经过另一条工作区内链接也不能绕过异常证据；范围解析期间的新变更仍拒绝提交。`web open --help`移除旧单行链接指引，遵循运行时skill在上下文和必要技能正文返回后的进度输出卡片约定。

三个运行缺口均先以真实临时Git/独立数据根回归复现失败，再修复通过；另补链接目标目录删除/重建及其它链接入口的范围检查，共新增5项回归。Windows / Node24.12.0实际完成CLI/Web构建及完整正式程序260项：256通过、4项平台跳过、无失败；跳过为两项POSIX SIGINT、POSIX大小写独立文件和非法UTF-8文件名，不借用旧平台结果。9 Schema/15正例/32预期拒绝反例通过，当前模型21对象/28关系/35证据无诊断。保留对象/证据身份、关系及历史；本次范围外73个已有变更文件的哈希不变。

证据独立保存在`.harness-local/validation/repair-f45c4a57-d2aa-404e-bd85-669564abe904/`，包含三个RED、针对性GREEN、完整`formal.log`/`formal.xml`及构建结果，未覆盖原验证产物。本轮未重跑Linux/macOS、浏览器或完整真实宿主验收，未更新全局CLI/常驻服务、未发布或暂存/commit/push；修复在当前工作区。

## v0.34：技能引用与选择理由编码

原任务选择理由实际保存为`??HEAD…`，已复现Windows PowerShell默认ASCII原生管道在CLI收到前丢失中文；CLI的UTF-8解码无法恢复合法问号。入口、按需参考、使用说明及CLI帮助改为中文JSON优先明确的UTF-8文件，UTF-8字节stdin继续支持。网页对替代字符或明显问号模式给疑似损坏提示，可展开完整原文；节点、正式及旧格式详情共用规则，普通中文、提问与`??`/`?.`保持原样，不拒绝请求或猜写历史。

完整库中的跨方法目标实际存在，但仅选择单个方法时不会归档兄弟目录或根维护说明。现移除20份通用头中的根说明链接和11份related清单，25个方法/附件文件中的跨技能指引改为必要的自包含行为；保留同方法真实附件、MIT与来源。21项逐一捕获后本地链接全部落在自己的归档中，库导航另去掉2个未随库提供的原型文档链接；用户自有related能力仍兼容，不扩张自动选择/归档。当前模型维护既有CLI/Web/入口/技能对象，新增4条源码/验证依据，21对象/28关系/35证据无诊断。

Windows / Node24.12.0：49项相关程序检查通过，另新增导航回归1项通过，共50项、无跳过或失败；并非重跑全量正式矩阵。涵盖UTF-8文件/BOM/中文路径及字节stdin选择后重启恢复、用户related兼容、单方法归档、自定义入口备份和历史投影。CLI/Web构建、9 Schema/15正例/32预期拒绝及运行时skill格式检查通过。Edge156实跑1440×1000和390×844详情、原文展开、真实归档预览及节点提示，方案/批次不变，无页面错误；本机截图原任务也已只读复验，未发选择/读取写请求。证据为`.harness-local/validation/skill-content-v034.json`、`skill-content-v034-tests.xml`、`skill-content-browser.json`及`skill-content-*.png`。

本机按用户本次要求定向清理活动junction所指技能实体的25个方法/附件和2个库导航文件；其它自定义内容及原README附加内容保留，旧字节先备份。已同步随包模板和两宿主入口（各2更新/3不变），网页2资产及index热更新，CLI帮助只替换编码提示；旧网页资产保留，后台instanceId/startedAt不变。未重启服务或替换核心服务代码，v0.33新核心机制仍以候选包为准；旧任务正文和理由仍是原始档案，当前技能修复不反写历史。

新候选独立保存在`.harness-local/artifacts/skill-content-20261107/harnessl3-0.1.0.tgz`，345071字节/140文件；全新隔离消费者安装/重装、21方法、归档往返、入口skill和2个离线资产通过，原v0.33候选保留。SHA512为`Hzk6WjLxXU/JJryxz0oXLWbBlT/QIYW7/6qd9v5naIp/ZKojqQCZMuO1/odR/ZHVLY4cQItDkHFsPfv+0daTYA==`。本轮未重跑Linux/macOS、完整宿主语义验收或全局CLI核心升级，未暂存/commit/push或发布。

## v0.33：文档留存与上下文闭环

审查已复现两个缺口：成功模型加载的证据警告未进入同步状态；显式引用的忽略文件变化未被即时观测。现保留带evidenceId的changed/missing/unreadable诊断，命中异常的proof路径/实体范围返回SYNC_UNRESOLVED；无关局部核验可保存，未解决范围仍pending，未引用记录不阻塞当前工作。显式本地引用在Git忽略/项目排除之外仍观测并推进代次，字节回退不能复用旧proof；来源manifest/策略不扩展，普通未引用技能及输出仍按原排除规则处理。

新增references核心模块批量只读检查本地document证据的Git归属。已跟踪文件不受ignore误报，未跟踪/被忽略/无法核查只提示，不强制先暂存或提交。入口及14项普通方法补充相应文档维护衔接，规格/任务Markdown/决策/研究/交接沿用项目权威；移动修复当前引用、保留身份，删除/替代清理当前引用而保留历史。quick在需核查长期关联时退出，CONTEXT附件不再无条件创建第二份权威。用户技能库和历史未被批量覆盖或迁移。

Windows / Node24.12.0：正式程序248项，244通过、4项明确平台跳过；另有新增CLI端到端和Windows大小写引用各1项通过，共246通过/4跳过。覆盖证据变更/缺失/不可读、移动修复、历史不变、无关局部proof、同文件孤立证据、忽略/排除引用、字节回退、Git索引原字节不变及未知Git降级。新增测试中的路径参数及重放字段预期已按真实接口修正，最终回归通过；未改产品错误契约或放宽证据检查。CLI/Web构建、9 Schema/15正例/32预期拒绝反例、运行时skill格式、21方法目录与255个本地链接核对通过；项目模型为21对象/28关系、31条证据无诊断，34个模型/依据文件的工作区与Git清洁转换字节一致。

候选包344280字节/140文件，全新隔离消费者的bin、安装/重装、21方法、归档往返、登录链接和2个离线Web资产通过；SHA512为`9M/h9ak5vUoraDWiR6TFASJ5khRLGbsPqowB6FZpVmtT9GDz+a+T9AEalT+tOXFqh7MbaTQKTzFahc84Q6CFSw==`。既有包已先保留，新包与验证结果分别保存在`.harness-local/artifacts/harnessl3-0.1.0.tgz`及`.harness-local/validation/document-lifecycle-v033.json`，完整正式程序报告另存同名前缀XML。既有31个受保护产品文件（包括先前未提交的Web/服务变更）原字节不变。本轮未重跑Linux/macOS或宣称完整宿主语义验收，未提交/发布、未替换全局CLI或重启共享服务；已有用户库按不覆盖约定保留。

## v0.32：恢复上下文返回后的提示

按用户最新要求撤回v0.31的完成后发送约束：实际上下文和必要技能正文返回当前agent后，取得真实链接，在进度消息中展示一次“查看HarnessL3的输出”卡片，再继续用户工作，最终答复不重复。引用块、加粗标题、空白引用行和箭头链接保持原样。运行时skill及两份参考、AGENTS、当前基准/D15、FR12/15、TC27和使用/架构/Web/CLI规格同步；模型仅更新Agent入口对象的时机说明。

本次入口的两次联合选择均因并行源码变化返回SOURCE_CHANGED，未产生有效交接或卡片；按运行时skill回退普通执行，不继续创建任务或伪报接入。Windows运行时skill格式校验通过，原安装器已同步本机Codex/Claude Code各5文件（各3更新/2不变），旧文件已备份；本轮核对124个本地Markdown链接。模型可解析为20对象/27关系，本轮更新的基准/skill证据匹配；core/model.ts、core/context.ts、core/freshness.ts和docs/spec/model-context.md四条证据因并行变化告警，属本任务范围之外，未替其它工作刷新或宣称全项目同步。提示/文档调整不新增文案镜像测试；证据保存在`.harness-local/validation/output-card-v032.json`。其它TUI/Claude Code真实行为及三平台呈现未验证。

## v0.31：完成后展示输出卡片（历史，时机已由v0.32替代）

提示来源为`agent-skills/harnessl3/SKILL.md`及运行参考/项目接入参考，项目AGENTS和规格重复约束；链接由现有agent调用`web open --no-open`取得后在宿主中输出。CLI提供真实URL及单个JSON封套，不渲染这张卡片。按用户要求，入口取得上下文和必要技能后继续工作，完成用户工作及必要核验后才在最终答复末尾展示一次，文案改为“查看HarnessL3的输出”。采用Markdown引用块、加粗标题、空白引用行及箭头链接，不包代码围栏或附裸网址；收尾时再取新链接，避免长任务提前生成登录码。空选择遵守同一时机，上下文返回或task close不冒充用户工作完成。

运行时skill、两份按需参考、当前基准/D15、AGENTS、使用说明、FR12/15、TC27及架构/Web/CLI规格同步；历史版本记录和任务回执保留。模型只更新Agent入口对象的提示义务，不改变关系或历史。Windows实跑skill-creator格式校验和7项既有安装程序检查全部通过；原有安装器已更新本机Codex/Claude Code运行时skill，每宿主3文件更新、2文件不变，旧字节分别备份到技能扫描根以外。不重装CLI或重启服务。本轮当前agent按用户要求把卡片留到最终答复；其它TUI渲染/点击、Claude Code真实宿主行为及三平台呈现仍待独立验证，不以文件校验代替TC27宿主验收。

## v0.30：精简任务创建与关闭标签

按用户要求，任务输入卡片与历史栏移除新建入口，空白工作区移除创建表单，相关前端创建/重试分支一并清除；标题、任务下拉与历史列表不显示“已关闭”。任务仍由现有agent通过CLI建立，网页现有任务的显式正文/技能选择与历史只读规则不变。旧关闭记录、服务状态与用户档案未改写。手动选择浏览门禁改用CLI预建的隔离任务，不再依赖网页创建。

Windows/Node24.12.0构建通过；Edge156在原关闭任务、任务下拉、历史列表/固定历史与空白工作区实际核对上述入口/标签均已移除，浏览前后原任务深比较不变，无写请求和页面错误。原任务正文叶子、输出连线及重复链接仍通过。截图已检查，证据为`.harness-local/validation/task-ui-browser.json`及`task-ui-*.png`。50个CLI/core/service构建文件与改动前原字节一致，仅更新本机网页资源及随包规格README，后台instanceId/startedAt保持不变。

既有手动选择浏览门禁已在隔离夹具中通过：两个任务由真实CLI建立，网页联合选择目录/两项正文/三个带理由技能，后续已知内容复用、真实提交后丢响应的同ID重试、三批不重复及显式空选均保持；无页面错误。证据为`task-ui-manual.json`。

新候选独立保存在`.harness-local/artifacts/task-ui-20261107/harnessl3-0.1.0.tgz`，337639字节/138文件；本机137文件原字节匹配，bin仅npm首行换行修正，两宿主10个入口文件一致，旧网页资产保留供已打开页面使用。SHA512为`fgBxOuMC1/pLzJF39Noiw14pjdP0hLRjN5tCgjU6ORIZNxsQtMNXCULM5eK9k5+MIL1BE9nkJvCyCsWKJ8H6eA==`；证据为`task-ui-package.json`、`task-ui-global-install.json`及`task-ui-hot-update.json`。本次未重启服务、未新验三平台或发布npm。

## v0.29：父对象正文命中与重复访问链接

原任务`fd21da4a-bcf3-4504-a215-583f743eedbc`实际只返回HarnessL3父对象自身的一项正文，并没有返回9个子对象。原布局展开后只有未命中聚合叶子，正文的绿色输出路径丢失。现为实际已返回且含子对象的父对象生成指向原实体的正文叶子，详情使用同一归档正文，不重复计数、点亮未读子对象或改写历史。仅后代命中的聚合祖先不生成正文叶子，收起后仍保留命中路径。

重复点击原URL时，前端原先再次兑换已消费登录码，即使cookie仍有效也返回401。服务现优先复用合法同源的有效浏览会话，不轮换cookie或延长12小时期限；新码仍被消费，无有效会话仍要求未过期/未消费码。Web将401显示为重新登录及重新生成入口的恢复状态，清除地址栏凭证时保留原目标，不再显示服务不可用。服务仍按用户数据根常驻，无空闲超时；5分钟一次性码和12小时会话均非进程寿命。

Windows/Node24.12.0实际验证：两个新增断言先分别以“没有命中叶子”和“401而非200”失败；修复后投影、Web服务、初始化及首次入口共16项通过，正式构建通过。Edge156实跑父对象叶子/原文/输出路径、重复原链接两次200、cookie及到期时间不变、刷新、匿名401准确提示、目标保留、新码恢复与任务前后深比较不变；另有3个既有浏览门禁及各10000未命中上下文/技能的合成投影通过，9/6个画布节点和50行分页边界保持。证据：`hit-session-browser.json`、`hit-session-existing-browser-gates.json`、`hit-session-large-nodes-browser.json`及同目录截图。

候选包337800字节/138文件，安装消费者往返、21方法、两宿主入口及离线资源通过。本机全局安装137文件原字节一致，bin仅npm首行换行修正，两宿主10个入口文件与包一致；SHA512为`/qQOdIxIVtFLq8XCQ4GmC3c5XGeoM/LmEoGy2bHbXxDzDQC9ccP7+mRcVAFsAh/yoW8krOSunHlPgqG17uDluA==`。已安装版本在上述原任务实跑同样通过，9个未读子对象仍聚合、精确正文原字节与历史记录不变，重复原链接均200，页面错误0且仅本机资源；证据为`hit-session-global-install.json`、`hit-session-actual.json`及截图。

更新服务时正常排空后停止并重启；首次启动触发CLI就绪期限BUSY，首次浏览读取也超过脚本默认30秒。确认原启动进程随后就绪再复验通过，没有强杀进程或清理用户档案。冷启动恢复迟缓未在本轮修复，不将暖态复验视为冷启动性能通过。本轮未发布npm，未新跑macOS/Linux或完整真实宿主入口验收。

## v0.28：命中节点与独立目录页

用户反馈展开后未命中节点过多。正式画布保留初始五类，各层只布局命中及其祖先，未命中兄弟合并为一个“…”；技能Hub只展示含已选技能的文件夹及已选成员，其余文件夹/成员采用相同入口。父层计数保留完整范围与已选数，未命中入口不点亮；布局只计算可见前沿并复用高度/技能投影，不复制未选文件引用用于画布。

DirectoryPage在独立URL页面中展示完整分支后代或技能目录，支持搜索、命中筛选和每页50项。刷新、浏览器前进/后退、返回相机、手机布局及详情定位可用；正文/目录/技能仍需显式候选和原批量提交，未选技能没有归档预览权限。当前目录变化在列表更新，历史继续使用当时模型/catalog和所选group/ID/字节，不补当前缺失内容。

Windows/Node24.12.0实际验证：4个初始投影场景因铺开未命中节点或缺少聚合入口失败，实现后连同显式空选共5项通过；正式构建、3个既有浏览门禁（手动选择/幂等重试、历史/手机/离线、技能目录生命周期）及首屏延迟回归通过。合成渲染负载在独立本机服务响应上注入各10000个未命中上下文/技能，展开区域分别9和6个节点，列表最多50行；搜索、分页、文件夹范围、刷新链接、前进/后退、相机、未选归档拒读和手机布局通过，原任务前后深比较不变。该最终合成首屏就绪样本2419ms含认证和网络响应处理，不是大仓库后端基准或SLA；截图已检查。证据为`.harness-local/validation/matched-nodes-browser.json`及同名前缀截图，既有门禁为`browser-win32.json`，首屏回归为`web-loading-browser.json`。

候选包337028字节/138文件，21方法及安装后上下文往返/离线资源验证通过；本机全局安装138文件中137原字节一致，bin仅npm首行换行修正，两宿主10个入口文件匹配且未重写。SHA512为`8Cu0ImmBR3EvF1B5+E3BcB5RgiezeAONLjdmXRQKStwupdu98SicYQMZBf5P8MTZOeLyCxX9+xQaQ8PET6sD4Q==`。17份改动Markdown的157个本地链接、26条证据哈希及模型20对象/27关系核对通过，拓扑未新增；本次未发布npm或新跑macOS/Linux增量验收。

实际已安装版本另用本机原Git建议任务（4项正文）只读复验：展开对象/核心层及技能文件夹，非类别实体节点均为真实命中，未命中入口可打开完整列表；脑图/列表/C4截图已检查，任务前后深比较不变，页面错误为0且只请求本机资源。3次暖`/view`为472/430/421ms，浏览器登录至任务就绪1752ms；只记录本机样本，不与另一个任务的旧基准作比较。证据为`matched-nodes-actual.json`及其截图，本机包字节核对为`matched-nodes-global-install.json`。

提交前核查发现本机`core.autocrlf=true`使24条当前证据的工作区原字节与Git暂存字节不同。当前仓库新增`.gitattributes`，仅将`.harness`和26个证据引用的项目文本固定为LF；先规范实际工作区字节再重新计算当前指纹，不使用Git blob替换已观察历史，也不改任务归档或用户技能库。26条证据现同时匹配工作区与暂存区，53个构建输出文件前后原字节一致；初始化/首次接入/投影12项回归、构建及暂存差异检查通过。基准正文同时对齐已确认v0.28的命中投影与列表交互，无新增产品决策或模型拓扑。

## v0.27：CLI上下文的Git提交范围

实际已安装CLI的start/prompt原先只给筛选规则，未提C4提交Git；D06的边界仅存在文档。现将模型目录（.c4/.likec4、specification/views）、项目配置、证据、别名与相关源码一并版本管理的建议加入返回规则和运行时skill。项目文档及仓库内真实技能/附件/许可证按归属纳入；本机登记、journal/历史/快照/归档技能、SQLite/缓存/布局、日志、机器配置及凭证排除但保留，不复制全局库或外部链接实体。提交建议不授权暂存/commit/push；封套、技能选择及旧幂等回执不改。

Windows/Node24.12.0实际验证：新增文件范围断言先因缺少`.harness/model/`失败，修改后通过；context、agent-skills、cli-help共38项及task-cli的文本/JSON/重启/隔离4项全部通过，正式构建通过。17份改动Markdown的156个真实本地链接和23条证据哈希核对通过。隔离消费者安装、21方法、上下文/技能往返、宿主skill重复安装及离线资源验证通过；本机全局安装138文件中137原字节一致，bin仅npm首行换行修正，两宿主共10文件匹配。实际已安装CLI在独立临时Git仓库的start/prompt均返回新规则，前后HEAD、工作区状态及暂存清单一致，证据在`.harness-local/validation/context-git-installed-cli.json`与`context-git-global-install.json`。候选包332868字节，SHA512为`WZs1sM/q/37bRt221sqmQCVzUg3FRjMi4Axph+H2CNcW73T04kttwt3AGWBb1lSEKO/pIsaNjby9rEgD2TZxbw==`；未发布npm，未新跑三平台或真实宿主全量入口验收。

## v0.26：任务入口加载与单行文字链接

真实本机已运行服务的同一历史任务`/view`实测15443ms，项目/工作区/任务列表分别59/243/292ms。定位到MigrationService.has为每次格式判断新建只读Archive，重复读取整个journal及全部快照/技能引用。现复用所属Runtime已加载的日志进行格式判断，所请求任务的归档校验仍保留；显式迁移检查保持独立只读路径。

前端原SSE reset在首个view未返回时取消它并重发，等待期间画出零命中和空任务。现同目标在途请求合并、完成后补取，切换目标仍取消旧请求并拒收旧结果；首屏数据未到只显示加载状态，首次相机定位在绘制前完成。运行时skill/参考/AGENTS及规格统一为实际上下文及必要方法正文返回后，仅输出单独一行“查看可视化过程”文字超链，不附使用或选择说明。

用户进一步要求清除正式产品中的注释性描述。主页去除CONTEXT/同一画布标签、泛化宣传标题、展开指导、来源/执行边界说明、计数解释、输入输出说明与手势说明；技能、结构、历史及旧格式详情去除固定注释，改为简短的实际状态与字段。保留任务名称、领域简述、选择理由、必要连接/加载/错误状态、原文及用户明确请求的诊断；不改动历史归档字节。AGENTS及Web/产品规格同步此交付约定。

Windows/Node24.12.0/Edge156.0.4314.58：后端和浏览器两条回归均实际RED→GREEN。程序相关回归50/50通过，包括归档损坏仍失败、迁移/GC、上下文与skill复制；帮助检查另3/3通过。浏览器注入首屏延迟跨过SSE reset时保持1个在途请求、0取消，输入/输出隐藏而加载提示可见，返回后2项正文、五类闭合和Hub闭合，0页面异常。证据在`.harness-local/validation/web-loading-{red,regression}.txt`、`web-loading-browser-{red,green}.txt`、`web-loading-browser.json`和`web-loading-fixed.png`。

清理文案后的完整三组浏览门禁通过：桌面/手机触摸/离线、历史与跨工作区隔离、手工选择/丢响应重试、技能目录生命周期；0页面异常。测试从旧说明文案定位改为连接状态/更新标记及当前操作名，未改产品行为以迁就测试。3个提交到绘制样本为928/855/887ms，P50/P95为887/928ms；只是本机三个样本，不宣称SLA。报告`.harness-local/validation/browser-win32.json`。随后移除结构视图的模型说明段落，以最终安装页面与结构弹窗补做视觉核对，截图为`web-loading-actual.png`与`web-loading-actual-structure.png`。

最终包完成全新中文/空格消费者安装、真实npm bin、21方法、两宿主skill复制/重复不改写、任务/归档正文/关闭及2离线资产检查。正常停服后更新本机全局CLI；138包文件中137原字节一致，bin仅npm首行CRLF→LF修正，两宿主10文件一致。SHA-512为`4scBGCOxeZNOSyj2xMlsIHEsDsK/LB4u/aEVlzrD7+vFtv+5b1vP7M2XhMcHUFtcM1PSDNGg0+6i6/O/OAFDXA==`，报告`web-loading-global-install.json`及`.harness-local/artifacts/package-smoke-win32.json`。更新前包和报告保存在`.harness-local/artifacts/before-web-loading-20261107-102825/`。

本机原任务复测：同一`/view`的三个热读取为482/424/396ms，浏览器登录到正确任务就绪871ms，任务原归档逐字段不变、0页面异常、仅本地资源。报告`.harness-local/validation/web-loading-actual.json`。前一次重启曾因历史恢复超过CLI就绪等待而返回BUSY，后台完成后只读重试成功；最终包此次重启未重试。这些结果证明本次已运行服务下的任务打开切片，不覆盖所有冷启动或大规模历史性能。

本次未运行新的macOS/Linux或Claude Code宿主行为，不能借旧三平台结果扩大TC21/27的通过范围；未推送或发布npm。

## v0.25：当前agent建模、结构完善与生命周期说明

调查确认旧init仅创建4份模板/配置并登记，不调用大模型；上一阶段实际模型只有1对象、0关系、0子层，未完成语义建模，不能用当时机械成功证明项目初始化完整。当前CLI增加initialization结果：scaffold-ready、not-assessed、实际对象/关系/视图数量及model-project/review-project-model动作，由当前agent继续真实阅读和直接写模型。主skill及接入参考要求阅读→建模→校验进度、覆盖核查及缺口披露，不引入另一个模型、agent启动或语义生成脚本；机械存储/解析/索引保留。

当前agent依据实际入口、核心资源装配、文件模块及正式/原型边界，直接编写`.harness/model/main.c4`、`02-relations.c4`和`03-views.c4`，保留原app UUID，补为20对象、27条静态依赖/指导/验证关系、3结构视图及23份来源证据。模型解析实际有效；覆盖正式主模块与关键依赖，不声称逐函数或全项目语义完整。证据指纹仅核对所引用文件，不替代语义审查，旧任务/历史不改写为新结构。

可视化提示从每组命令前改为实际上下文返回且必要skill正文读取之后，只显示harnessl3提示与“查看可视化过程”Markdown链接，不另附裸网址或常规有效期文案。当前会话已在实际读取上下文及所选方法正文/交接之后显示链接；安装文件文本核对不能替代其它宿主自动遵守的验收。

服务调查确认：默认用户数据根跨项目/任务复用常驻单实例，无空闲退出时限；显式数据根隔离继续有效。网页一次登录码5分钟/一次性、成功浏览会话12小时一直是访问凭证期限，非服务寿命。serve结果新增startedAt/scope/lifetime，web open分别返回service和login；使用已消费/过期码的错误也明确不表示后台退出。未放宽认证或改为固定端口。

本机Windows/Node24.12.0的两个新增接口切片分别实际RED→GREEN：init语义后续动作、服务/登录期限分离；随后手工文件型模型保留与真实拓扑数量切片通过，3/3。证据在`.harness-local/validation/agent-init-red-20261107.xml`、`service-lifetime-red-20261107.xml`及`agent-authored-model-green-20261107.xml`。相关回归49/49、CLI/Web构建、skill校验、15份变动Markdown的146个本地链接和diff检查通过；报告`agent-init-regression-20261107.xml`。新平台/宿主范围不沿用旧证据。

全新中文/空格消费者安装、真实npm bin、两宿主各5文件及重装不重写、21方法、任务/交接/归档正文/关闭和2个离线资产通过；新增scaffold语义后续动作及service/login结果也通过。用户此前的本机更新授权沿用，正常停旧服务后更新全局CLI和两宿主skill；138包文件中137原字节匹配，bin仅npm首行换行修正，两宿主10文件均匹配。包SHA-512为`Q/8Vt9xiAHW1nl6u+b2Tm8teYhLY6glFaudpHfesoXqZ0Dv1NSyIEtGmEpMp/Ty/JuSEfLYo8Yk+WKqxzmX4Yw==`；报告`agent-init-global-install-20261107.json`与`package-smoke-win32.json`。已安装CLI实际返回当前模型20对象/27关系/3视图和review-project-model，仍不伪报机器评估了语义。

当前agent按新版本任务实际取得12项模型正文、2项目录、0读取错误后再提示格式化链接。Edge156.0.4314.58实跑对象逐层展开、3视图切换及核心图14节点/20边，0页面异常、0浏览触发的读取；23份证据指纹全部匹配。视图采用既有紧凑节点样式以避免长局部说明撑大C4布局，旧模型任务仍保留当时结构，新版本另建档。首个浏览脚本使用显示文本“结构”定位失败，按实际无障碍名“项目结构”修正后通过，不把脚本定位问题记为产品失败。证据`agent-init-actual-web-20261107.json`与`agent-init-structure-*.png`；覆盖正式主要模块/关键依赖，不作逐函数或全项目语义完成声明。没有运行本次macOS/Linux或Claude Code自动发现/交互，TC27不标完整passed；未提交、推送或发布npm。

## v0.24：首次接入询问与调用前可视化链接

用户反馈未登记只报错退出。当前CLI在无显式目标且cwd为未登记Git worktree时，以`TARGET_REQUIRED.details.onboarding`返回实际根路径、初始化/登记命令、需确认和拒绝回退指引；不自动写入工作区。无Git目录或显式目标不全/冲突不产生首次接入建议。`web open --no-open`返回现有短时一次性浏览登录链接及`opened:false`，不启动浏览器；显式task失败不降级成无目标链接，认证与读取计量保持。

主skill及接入/运行参考要求使用agent通用询问窗口，展示路径与影响，同意后接入并恢复任务，拒绝/取消后本任务普通执行且不再询问；已有授权复用，无回复不算同意。首次CLI调用前说明使用harnessl3和正在获取地址，取得真实链接后每组任务命令前展示名称与链接；Web失败不阻断可用CLI。D15/FR02/12/15、TC27、基准和AGENTS已同步；无新增Hook、agent启动、宿主或自动Git生命周期。

本机Windows/Node24.12.0的隔离行为测试先出现3项实际RED（缺接入指引两项、--no-open未知参数一项），修复后4/4通过，涵盖未同意不写入、显式初始化后恢复任务、已有配置保留、错误目标及可登录/精确task链接，浏览不续期。证据：`.harness-local/validation/first-use-red-20261107.txt`与`first-use-green-20261107.xml`。这些程序调用不模拟用户的真实拒绝流程；拒绝/取消及Claude Code宿主行为仍需独立实跑，不能借旧三平台CI或skill文字核对宣称TC27完整通过。

本次真实Codux/Codex会话通过通用询问窗口收到用户同意；在`I:/AI/HarnessL3`当前main完成init（4份缺失文件、首次默认技能库）及模型校验，执行前在agent输出流展示实际后台Web链接。首个task start连接中断后先查询得到任务列表为空，再用原requestId重试，建档及一次显式空选择成功；未盲目换ID重复建档。当前项目仅有人工维护的项目边界模型，内部模块未建模，保持needs-review；本次局部同步不证明全项目已核验。

相关Windows回归46/46通过；帮助增加--no-open发现性断言后另3/3通过，轮次不合并。CLI/Web构建、skill-creator校验、14份变动Markdown的137个本地链接及git diff --check通过。最新包的全新中文/空格消费者安装、真实npm bin、两宿主各5份skill及重复复制、21项Hub方法、init/start/select/handoff/read/close和2个离线资源均通过；新增后台初始链接和精确task链接也通过。包报告`.harness-local/artifacts/package-smoke-win32.json`，相关回归报告`first-use-regression-20261107.xml`。

实际任务链接在本机Edge156.0.4314.58中打开后，任务标题与归档一致、URL定位同一task、0页面异常；证据为`.harness-local/validation/first-use-actual-web-20261107.json`及PNG。默认Playwright Chromium未安装，改用已有Edge；首个Edge脚本的中文经PowerShell stdin变成问号而超时，改为从归档取预期标题后验证通过，不记为产品浏览失败或三平台结果。

用户另外明确同意将此修复包更新本机全局CLI及两宿主skill。更新前正常停服，安装包为`.harness-local/artifacts/harnessl3-0.1.0.tgz`；138包文件中137原字节相同，bin仅首行CRLF→LF符合npm修正，两个宿主共10份skill与包字节一致，旧skill已按安装器规则备份。已安装CLI支持--no-open并定位原任务，模型校验及归档handoff通过；全局安装证据在`first-use-global-install-20261107.json`及`first-use-installed-skills-20261107.json`。安装包SHA-512为`lmHcpvu/nz2kjV5Lx0iC1sIrOoQWXdvyxWYDF0iPOW3fPCpm3RuX0BRCqnrxBFxmFmXTtgcrkHXPJ8N3vH5ZpA==`。未推送或发布npm；真实拒绝/取消、Claude Code加载/询问及新macOS/Linux增量未运行，TC27不标完整passed。

## v0.23：GitHub真实本机安装与更新

本轮按[安装指南](../../INSTALL.md)在Windows/Node24.12.0/npm11.6.2/Git2.51.0执行真实全局安装。旧指南的审阅分支已删除，原样HTTPS浅clone退出128；核实GitHub主干内容后修正安装来源。首次安装取得`b0b8415`；按用户要求精简面向使用者的文案后，从GitHub下载`804d152`的INSTALL原文，再执行其完整PowerShell代码块完成更新。下载内容的Git blob与来源提交一致，未以本地开发目录或预先构建包替代。

- 两次流程均实际完成独立HTTPS克隆、`npm ci`、CLI/Web构建、打包、真实npm全局安装和两宿主skill复制。命令位于默认全局prefix，已在PATH，`harnessl3 --version`返回`0.1.0`；帮助给出的Schema路径属于已安装包。
- 最终包138文件，安装目录为实体而非临时源码链接。137文件SHA-256与包内原字节一致；唯一差异为`bin/harnessl3.mjs`的shebang首行CRLF→LF，563→562字节，已核对本机npm的`bin-links/lib/fix-bin.js`及严格首行变换，其余字节一致。没有用全文件换行归一化掩盖差异。
- Codex的`~/.agents/skills/harnessl3`及Claude Code的`~/.claude/skills/harnessl3`各5文件与安装包字节一致。更新时仅变动的安装参考文件被替换并按原规则备份；再运行复制程序，两宿主及全部10文件均为`unchanged`。
- 用全局`harnessl3.cmd`在本次独立克隆及其旁侧独立数据根执行init、模型校验、task start/select/handoff/read、history list及task close：目录实际21方法，读取1个上下文，选择`development/quick`，归档正文SHA与原引用一致。8个业务调用通过，自有服务已正常停止；当前用户项目未初始化，真实机器技能库和原85条任务未用于测试。
- 同一安装的Web入口及2个本地JS/CSS资产HTTP均返回200；没有运行浏览器交互或启动Codex/Claude Code。文件复制及本次手动调用不证明真实宿主已加载或自动触发skill，TC27仍保持待验收。此次没有新增原生macOS/Linux结果；PowerShell语法与Git Bash的Bash语法检查通过。

skill复制回归7/7通过。完整脚本记录、来源/包摘要、10文件核对、逐命令响应和停服结果在本机忽略目录`.harness-local/validation/github-install-20261106-172532/`；未提交真实安装目录、机器数据或宿主备份。安装和使用文档已清除日期、候选状态、分支迁移及内部验收过程，这些事实仅在本工程记录留存。

## 普通方法引入阶段：quick

新增 [development/quick](../../skills/development/quick/SKILL.md)，用于简单询问及目标、位置、改法已明确的小范围代码或文档修改。L3 入口与技能筛选后直接完成，不额外创建过程记录、不安排测试或其它验证；已有入口记录和宿主日志保留。方法不改变 CLI 持久化、同步机制或宿主启动边界。当前库为7类21项方法，导航、当前分发说明及既有数量断言同步；引入阶段仅维护方法文件及引用，当时未运行测试、构建或安装包验证。当前真实21方法安装验证另见上方v0.23；下列20方法的包与三平台结果保留为此前实际证据。

## v0.22增量：全任务入口与路由去重

用户确认D15/FR15：安装运行时skill后所有任务先经L3组织上下文/筛选技能，参考本机harnesslite的1%门槛；问答、研究、规划、实施、审查、继续、交接等均覆盖，不因轻量/只读绕过。连续有效任务复用，空选择合法；已有父L3交接的subagent继承范围与选择，无可用交接的独立子任务单独建档。新增`references/subagent.md`，父任务关闭/重选限制为工作约定，CLI未实现专属权限隔离或父子字段。不增Hook/agent启动/自动worktree；入口恢复不递归，缺有效目标/能力真实报告。主skill、基准0.22、AGENTS、FR15与TC27已同步；真实Codex/Claude Code的触发和委派行为尚未运行，不能标TC27完整passed。

`routingPrompt`已去掉任务身份/目的/绑定/目录/catalog的内嵌副本，只保留规则并指向结构化返回；任务目的在档案中保留，旧幂等回执不重写。非JSON模式展示规则后不在数据中重复打印同一规则，JSON封套及字段保持。隔离单夹具实测提示2574→1043字节、序列化入口JSON（不含末尾换行）4363→2700字节；不外推数值SLA或模型效果。新增提示去重及文本去重均有实际RED；当前API支持的父交接读取/一次选择、独立子任务与父任务生命周期分开也有程序切片检查。本轮Windows回归47项全部通过，CLI编译、skill校验、9Schema/15示例/32拒绝反例及跨字段核对通过；17份改动Markdown的128个本地链接目标核查通过。最新包消费者137文件、20项Hub方法，两宿主各5文件（主入口+4参考）字节匹配且重复安装不重写；已安装CLI的去重入口、帮助定位、init/start/select/handoff/read/close及离线资源通过，证据为`.harness-local/artifacts/package-smoke-win32.json`。TC27完整宿主行为仍待验收，不借旧三平台CI背书。

## 后续增量：宿主运行时 skill（2026-11-06）

新增独立文件型 [harnessl3 skill](../../agent-skills/harnessl3/SKILL.md)，主入口负责何时调用、返回含义与后续使用，保留少量启动示例；安装更新、项目初始化、复杂运行细节放在按需参考中，v0.22另加子任务参考。首次[职责核对](CLI_SKILL_REVIEW.md)移出接口字段与参数教学时，主文件不含换行字符由3801降为1176（约69%，为该轮记录，不是当前长度/token/模型效果指标）。现有CLI的 `--help` 支持总览/组/具体命令，参数及必需项复用解析器，具体请求契约及示例路径指向当前安装包，未改变业务命令和JSON封套。包内显式[复制程序](../../scripts/install-agent-skills.mjs)由根目录[安装指南](../../INSTALL.md)在程序安装/更新后调用，复制整个skill及附件，默认目标为 Codex 的 `~/.agents/skills/harnessl3` 和 Claude Code 的 `~/.claude/skills/harnessl3`。原有 Hub 仍为7类20项方法；D01–D14的权威/接入边界不变，当前基准0.22另增D15。

该阶段仅有本机 Windows/Node24.12.0 的实际结果：初版6项复制测试通过，附件扩展后7项目录复制/重装/逐文件备份/嵌套链接预检/部分失败/参数校验测试通过；缺模块、继承属性参数、附件目录复制缺失的失败到修复通过均实际运行。skill-creator 校验、构建与包消费者安装通过。初轮附件包为133文件/每宿主3文件，帮助修补及运行参考后的上一阶段包为136文件，仍含原20项 Hub 方法；两宿主各4个文件（主入口与3份参考）字节匹配、重复复制不重写，已安装 CLI 的子命令帮助给出的请求Schema路径确认属于安装包，init/start/select/handoff/read/close 与离线资源检查通过。当前0.22最新包与回归另列于上方；测试始终只使用隔离前缀、数据根、仓库和宿主技能目录。

本轮帮助修补另有3项真实RED→GREEN；与CLI服务/任务/源码同步及技能复制合并回归18项全部通过，`build:cli`通过。9个Schema、15个示例、32个预期拒绝反例及跨字段检查、skill校验与文档本地链接核对通过。Windows PowerShell/Bash安装代码块语法此前已核对；Bash为 Git Bash 语法检查。本增量未在原生 macOS/Linux运行，未启动真实 Codex/Claude Code验证其加载或模型选择行为，不能借下文 `f8eb2a4` 的三平台结果替此增量背书。当前改动尚未提交/推送或发布，只有上传后的源码才可经 GitHub 安装取得新 skill。

## 已有实现

| 范围 | 当前行为 | 主要代码/检查 |
| --- | --- | --- |
| 工程与工作区 | Node24.12/TS ESM；多项目及已有worktree登记；UUID/common-dir身份、目标及数据根隔离；init/seed不覆盖 | core/workspace.ts、paths.ts；workspace、cli-service、service-recovery |
| 文本模型 | 真实LikeC41.60解析、稳定UUID、别名/证据及多视图；无效模型保留有版本标记的有效结构 | core/model.ts；model、context、web-service |
| 上下文/技能 | 多目录/精确正文/跨层、首次known保护、partial、一次联合技能选择及显式空集；归档文件按需读 | core/context.ts、skills.ts；context、skills、task-cli |
| 持久化/历史 | 文件journal/不可变归档、幂等回执、提交恢复、worker SQLite重建；60天包含边界、分页及批次恢复 | core/archive.ts、index*.ts；archive、index、context |
| 源码同步 | 原始字节/忽略规则/策略、watcher epoch及扫描、模型与来源两轴、局部proof/CAS及真实失败 | core/source.ts、freshness.ts；source、freshness、sync-cli |
| 只读日志 | 显式绑定两宿主已核验子集；结果匹配、检查点、轮转/缺口/未知；不保存聊天正文或执行日志命令 | core/observation.ts；observation、observation-replay、agent-cli |
| 正式Web | Slate统一脑图、五类/Hub文件夹、真实批量选择、项目/worktree、历史/C4、SSE、锚点/触摸/离线 | web/；verify-fixture、verify-manual、verify-directory |
| 维护与包 | legacy复制导入/dry-run/幂等/冲突；保守GC；此前本地tgz的20项技能及离线资源已验，当前seed新增quick为21项，包未重验 | core/maintenance.ts；maintenance、maintenance-cli、package-smoke |

调用顺序见[使用说明](../USAGE.md)。现有agent主动调用；CLI不启动agent、不执行技能、不管理Git worktree生命周期。当前本地候选版本0.1.0，未向npm发布。

源码/知识同步核对：正式模块与命令已对照架构、CLI及存储契约；本轮轮询、截断和字面量字段界限同步到[观测规格](../spec/observation-sync.md)。MGRP示例模型/证据及普通技能没有改动，原字节列入保护核验；本轮不对其外部业务源码作新的语义同步声明。

## 本轮实际结果

测试使用外部临时Git、数据根、日志与技能副本。真实85份开发任务不是恢复/迁移/GC夹具；202个受保护文件已再次核对SHA-256全部一致。

| 环境/检查 | 实际结果与范围 |
| --- | --- |
| Windows程序全量轮次 | 242项：239通过、0失败、3项明确平台跳过；197项正式检查与45项原型回归分开。首次after清理EBUSY已修；中间新增真实fixture的RED也单独保留，最终使用完整固定夹具重跑通过。后补原生FS专项另列 |
| Windows日志幂等修复 | 先2项RED，修复后19/19通过；已提交alias路径失效先重放回执。bind-replay-red.xml / bind-replay-green.xml留存 |
| Windows正式浏览器 | browser-smoke统一三组通过、0 page errors。含三技能联合选择、空集、丢响应后同ID重试、目录增改删/恢复、固定历史、legacy/C4、目标竞态、触摸/离线；[命令和JSON](../../web/README.md) |
| Windows本地包 | 全新中文/空格消费者安装、实际npm bin shim、任务→选择→归档文件读取均通过；128文件、20技能、2本地Web资产、sha512核验 |
| 原生Linux首次完整程序 | 239项：238通过、1失败、0跳过。实际recursive fs.watch返回string，被误按Buffer解码而unknown；已保留RED并修复 |
| 原生Linux最终完整程序 | 修复后241/241通过、0跳过；随后新增的真实Codex失败样本连同日志/alias在独立19/19中通过。两次报告分开，不拼称一次242项报告；freshness/source32/32的RED→GREEN另存 |
| 原生Linux浏览器/包 | Chromium156的三组browser-smoke通过、0 page errors；中文/空格消费者安装、实际npm bin shim及归档任务链通过。128文件、20技能、2资产及sha512核验 |
| TC26原生FS专项 | 后补2项：Windows真实FileShare.None外部持锁下原子替换拒绝/旧字节不变，释放后成功；Linux同目录大小写文件的Git路径/哈希/变更分离。两平台各1通过/1明确能力跳过，无sleep；不拼入先前完整轮次数字 |
| 历史三平台CI程序 | 第三轮每平台244项（199正式+45原型回归）：Windows240通过/4平台跳过，Linux243通过/1跳过，macOS241通过/3能力跳过，全部0失败；不是终版轮次的数量 |
| 最终三平台CI | 第六轮每平台256项（211正式检查+45原型回归）：Windows252通过/4平台跳过、Linux255通过/1跳过、macOS253通过/3能力跳过，全部0失败。三平台构建、显式CRLF浏览、安装和证据上传全部成功；第五轮也独立成功，轮次不合并 |
| Windows CRLF浏览回归 | 第四轮准确定位textarea的LF显示值与CRLF归档比较失败；在Chromium156、TEMP/TMP junction和显式CRLF种子下复现RED。分开校验API原字节/原引用SHA-256/长度与显示换行后，同条件三组全部通过、0页面异常；未修改生产前端 |
| 双日志补充回归 | Claude真实失败/Glob/有限Read/literal Bash/歧义中断，Codex有限Read/搜索/异步完成及空poll已加入最小脱敏夹具。空poll匹配及跨帧截断先4项行为RED，修复后observation29+replay2+agent CLI1在Windows/Linux各32/32通过。继承字段误归因另有实际1项RED，无原型解码修复后相同32项在两平台全部通过，并进入最终三平台通过轮次 |
| 性能 | 全量基线四规模112冷热组、336/336样本成功，28文件指纹在该轮一致。10000对象完整CLI混合读冷/热P50为99.59s/102.51s，最高RSS 2.73GiB。其后只有观测模块指纹改变，两个修复阶段分别独立复测日志积压8组24样本，均全部成功；[完整方法、表格及限制](PERFORMANCE.md)，不混样本、不声明SLA |

Windows使用Node24.12.0/npm11.6.2/Git2.51、Edge156；Linux使用WSL Ubuntu内原生Node24.12.0/Git2.43/Chromium，非Windows可执行文件透传。手机是390×844触摸仿真，不代表全部物理设备。原生Linux早期139项核心通过仅有命令输出，首次JUnit因临时目录清空未保留；后续脚本均退出前回存报告，不编造缺失报告。

已观察的平台能力跳过分开保留：Windows四项为两项POSIX信号取消、原始非法UTF-8文件名和POSIX大小写文件夹具（Windows原生取消另有ConPTY验证）；Linux一项为Windows独占文件共享锁；macOS三项为Windows锁、创建非法UTF-8文件名报EILSEQ、当前卷不能同时创建大小写不同的文件。其它平台已实际执行相应原生断言，未用这些跳过掩盖通用扫描或归档失败。

JUnit/浏览报告在本机`.harness-local/validation/`；阶段RED/GREEN、保护清单及性能原始样本在`.harness-local/implementation-20261105/`；最终包与安装报告在`.harness-local/artifacts/`。上述本机产物不随Git提交。

本地交付文件为`.harness-local/artifacts/harnessl3-0.1.0.tgz`：306989字节、解包1082537字节，128文件/20技能/2资产；最终SHA-512为`bkNVHjgJQ70wAlxflgEXA9ipBbM5eMAX2c7CKO7nUjWSrcMptcthxf0yGfScMqHaHgkMOBM3jVK4YSItFCKvow==`。归档摘要、全新安装、实际bin shim与任务读取链均已核验。使用Node24.12及Git，按[使用说明](../USAGE.md)安装和初始化；该tgz保留在本机，未发布公共npm。

## 原生CI运行记录

源代码、规格与测试已推至`codex/harnessl3-v1-20261106`，独立审阅worktree为`I:/AI/HarnessL3-review-v1-20261106`；原工作区main未切换，本机任务/日志/缓存未上传，未合并或发布npm。

- [首轮42066774412](https://github.com/LChJo/HarnessL3/actions/runs/42066774412)，`9f020fb`：整体失败；Ubuntu全部成功，Windows在npm test失败、浏览和安装因此未执行，macOS测试阶段长时间等待。实际失败保留，不能用本机通过掩盖。
- macOS路径前提已在Linux原生symlink TMPDIR下复现：取消测试用字面临时路径生成fake服务身份，而CLI使用canonical路径，导致等待服务接受无限挂起。原测试8秒超时RED；仅修夹具canonicalization、提前退出检测及20秒有界超时，同一前提2/2 GREEN，产品代码未改。
- [第二轮42069264423](https://github.com/LChJo/HarnessL3/actions/runs/42069264423)，`a389e40`：Ubuntu全通过；Windows237通过/3失败/4跳过，macOS238通过/4失败/2跳过。失败是fixture把Windows 8.3或macOS `/var`别名与canonical路径直接比较，另有Darwin不允许创建非法UTF-8文件名。新增JUnit摘要取得了准确断言；macOS上传报告另遇网络超时，未隐藏。
- foundation与maintenance夹具统一真实路径后，同样alias前提在Linux和Windows回归。Darwin只在创建非法文件名报`EILSEQ`时明确能力跳过；Linux仍真实执行编码诊断断言，未跳过扫描错误或放宽GC竞态断言。
- [第三轮42070719498](https://github.com/LChJo/HarnessL3/actions/runs/42070719498)，`2904010`：三平台程序全通过；Linux/macOS所有步骤成功，Windows browser-smoke失败。第四轮`73fb8ee`增加浏览/安装步骤的脱敏失败注释，继续定位，不把通用exit1猜成某个产品问题。
- [第四轮42073640063](https://github.com/LChJo/HarnessL3/actions/runs/42073640063)，`73fb8ee`：Linux/macOS全部成功；Windows程序通过、浏览失败。注释取得了准确的CRLF/LF断言，同条件本机RED→GREEN后，仅修验证脚本，并在第五轮三个平台显式注入CRLF种子。
- [第五轮42077870795](https://github.com/LChJo/HarnessL3/actions/runs/42077870795)，`5172157`：三平台全部成功，每平台256项程序检查；含日志空poll及跨帧截断修复、额外真实夹具、显式CRLF浏览归档字节核验及全新消费者安装。其后新增的继承字段保护由第六轮独立验证。
- [第六轮42079069041](https://github.com/LChJo/HarnessL3/actions/runs/42079069041)，`f8eb2a4`：最终三平台全部成功；每平台256项程序检查，浏览器与全新消费者安装均实际运行。字面量继承字段保护修复在本机Windows及原生Linux各32项通过后推送；最终公开结果和三份平台证据已生成。本机状态查询的一次网络超时没有被记为产品测试失败。

## 验收证据导航

下表列出首版验收的实际证据范围；工具子集和平台能力限制不补成完整覆盖。

| 场景 | 验证入口 | 当前边界 |
| --- | --- | --- |
| TC01–03、22–23 | workspace、cli-service、service-recovery、task-cli、cancellation | 三平台原生CI程序已实跑通过。Windows真实ConPTY另确认CLI子进程exit130；POSIX两项取消在Linux/macOS CI通过，Windows明确跳过POSIX信号夹具 |
| TC04–06、09、13–16、18–19 | model、skills、archive、index、context、task-cli及浏览器 | 精确读取、幂等/恢复、旧模型/技能/批次均从归档验证；三平台最终程序及浏览通过 |
| TC07–08 | source、freshness、sync-cli | 外部Git过滤器保守unknown，不执行用户脚本；Linux watcher实际差异已修复 |
| TC10–12 | observation、observation-replay、agent-cli及脱敏fixtures | 两宿主真实成功/失败、搜索、有限读取、受控迟到结果及自然完成空poll均有明确范围；歧义中断保留失败/未知类别。直接poll语法和未截断完成链仍synthetic-only；动态/聚合无法归因、非空poll及未验证格式保持未知，不泛称全部宿主工具覆盖。见[样本说明](../../tests/v1/fixtures/observation/README.md) |
| TC15、20–21 | web/verify-all.mjs三组 | Windows Edge及三平台Chromium通过；本机Windows显式CRLF/目录别名回归通过，最终三平台CI均显式使用CRLF种子 |
| TC17 | benchmark及browser-smoke commit→paint | 四规模/冷热/双worktree/恢复采样；明确共享机器负载与OS页缓存未清空，报告无SLA |
| TC24–25 | maintenance、maintenance-cli | 仅合成legacy复制，真实85任务不变；GC重算引用/租约，不删历史、技能实体或未知文件 |
| TC26 | build、browser-smoke、package-smoke、原生CI | 三平台最终构建/浏览/全新安装通过；Windows锁、Linux大小写原生断言有独立证据，能力跳过见上。手机为触摸仿真；未扩称所有物理设备通过 |

## 留痕与交付边界

早期M1/M2独立里程碑已写终端summary 8abe226e-29df-41cb-a3ce-08c5b48d97ce并读回；未修改共享notes。原型45项程序与正式程序分开统计，不用原型历史报告替代正式验收。

此前文档检查覆盖33份Markdown的249个内部链接/锚点；本轮当前文档范围25份/229链接最终检查通过，两次范围分开。9个Schema、15个正例、32个预期拒绝反例及跨字段检查通过，15正例另用核心Ajv2020全部验证。保护SHA清单核查202项无变化。

早期Windows Edge事件到可见输出三样本P50/P95为1668/1668ms，Linux Chromium为976/1236ms；最终Windows Chromium在显式CRLF与临时目录别名下为1156/1361ms。各轮不合并：定义是journal提交时间到准确输出数可见后的双requestAnimationFrame，含刷新/绘制调度、同机壁钟且每轮仅三样本，不是稳定长尾SLA。

第二个独立里程碑summary cda7ceb7-5c04-4d99-904b-8fd9896f05cf已写并读回。该里程碑正式首版范围的实现、原生CI、安装和测量均有实际结果，交付时基准v0.21；当前0.22的入口增量另列于上方，原型独立归档见当前基准，不改变首版验证范围。日志兼容范围已经逐项注明，未能归因的真实行为保留unknown，不能扩称完整宿主覆盖。数值SLA、更多宿主格式、公共npm发布及物理设备兼容属于后续范围；部分自建合成文件因自动审批拒绝删除而保留，见[清理记录](CLEANUP.md)。最终留痕在完成文档/保护复核后写入终端summary，不修改共享notes。
